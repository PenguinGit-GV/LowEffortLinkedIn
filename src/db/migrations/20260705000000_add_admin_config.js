// Admin config UI — plans/env-var-ui-feature-spec.md.
// config_overrides holds only values that differ from the Railway env
// default; deleting a row resets that key. Bootstrap secrets (DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, OAUTH_STATE_SECRET, SLACK_SIGNING_SECRET,
// SLACK_BOT_TOKEN, SLACK_CLIENT_ID/SECRET) and MARKETER_SLACK_IDS (controls
// who can reach this UI at all — self-service editing is a lockout /
// privilege-escalation risk, see spec Finding F1) are enforced server-side
// via the allow-list in src/admin/allowList.js, not by this schema.

exports.up = async function up(knex) {
  await knex.schema.createTable('config_overrides', (t) => {
    t.text('key').primary();
    // AES-256-GCM encrypted (reuses TOKEN_ENCRYPTION_KEY) when is_sensitive;
    // plaintext otherwise.
    t.text('value').notNullable();
    t.boolean('is_sensitive').notNullable();
    t.text('updated_by').notNullable(); // slack_user_id
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('config_audit', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('key').notNullable();
    t.text('action').notNullable(); // 'set' | 'reset'
    // Redacted display strings only — never ciphertext or raw plaintext
    // (spec Finding F5: even nominally non-sensitive fields get a
    // secret-shaped-value heuristic applied before landing here).
    t.text('old_value_display');
    t.text('new_value_display');
    t.text('changed_by').notNullable(); // slack_user_id
    t.timestamp('changed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `ALTER TABLE config_audit ADD CONSTRAINT config_audit_action_check CHECK (action IN ('set','reset'))`
  );
  await knex.raw(`CREATE INDEX idx_config_audit_key ON config_audit(key)`);
  await knex.raw(`CREATE INDEX idx_config_audit_changed_at ON config_audit(changed_at DESC)`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('config_audit');
  await knex.schema.dropTableIfExists('config_overrides');
};
