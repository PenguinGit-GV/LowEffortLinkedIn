// Initial schema — PLAN.md §5. gen_random_uuid() is core in PostgreSQL 13+.

exports.up = async function up(knex) {
  await knex.schema.createTable('users', (t) => {
    t.text('slack_user_id').primary();
    t.text('linkedin_access_token'); // AES-256-GCM encrypted in app, base64
    t.text('linkedin_person_id');
    t.timestamp('token_expires_at', { useTz: true });
    // Dedupes the reminder job; cleared on reconnect (PLAN.md §2.2 step 4).
    t.timestamp('expiry_reminder_sent_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('posts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('destination_url').notNullable();
    t.text('caption_a').notNullable();
    t.text('caption_b');
    t.text('caption_c');
    t.text('image_slack_file_id'); // Slack file ID of the optional image
    t.text('slack_channel_id'); // where the card was broadcast
    t.text('slack_message_ts'); // card message ts, for chat.update
    t.text('created_by_slack_id').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('shares', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('post_id').notNullable().references('id').inTable('posts');
    // /disconnect all erases history via cascade (PLAN.md §2.4).
    t.text('slack_user_id')
      .notNullable()
      .references('slack_user_id')
      .inTable('users')
      .onDelete('CASCADE');
    t.text('variation').notNullable();
    t.text('custom_text'); // set only when variation = 'CUSTOM'
    t.text('linkedin_post_urn');
    t.text('status').notNullable();
    t.text('error_message');
    t.timestamp('shared_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(
    `ALTER TABLE shares ADD CONSTRAINT shares_variation_check CHECK (variation IN ('A','B','C','CUSTOM'))`
  );
  await knex.raw(
    `ALTER TABLE shares ADD CONSTRAINT shares_status_check CHECK (status IN ('success','failed'))`
  );
  await knex.raw(`CREATE INDEX idx_shares_post_id ON shares(post_id)`);
  await knex.raw(`CREATE INDEX idx_shares_slack_user_id ON shares(slack_user_id)`);
  // Durable idempotency backstop: one successful share per person per post (§2.3).
  await knex.raw(
    `CREATE UNIQUE INDEX idx_shares_once_per_user_post
       ON shares(post_id, slack_user_id) WHERE status = 'success'`
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('shares');
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.dropTableIfExists('users');
};
