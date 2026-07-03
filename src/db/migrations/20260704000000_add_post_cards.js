// Multi-channel broadcast — a single /create-post can now fan the same card
// out to every channel in ADVOCACY_CHANNEL_ID (comma-separated). Each
// broadcast's (channel, ts) is recorded here so the share counter and the
// post-expiry job can update *every* card, not just the first one.
//
// The posts.slack_channel_id / slack_message_ts columns are kept as the
// "primary" card (the first successful broadcast) for backward-compatible
// reads and for the expiry job's due-scan filter; posts created before this
// migration have no post_cards rows and fall back to those columns.

exports.up = async function up(knex) {
  await knex.schema.createTable('post_cards', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('post_id').notNullable().references('id').inTable('posts').onDelete('CASCADE');
    t.text('slack_channel_id').notNullable(); // channel the card was broadcast to
    t.text('slack_message_ts').notNullable(); // card message ts, for chat.update
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`CREATE INDEX idx_post_cards_post_id ON post_cards(post_id)`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('post_cards');
};
