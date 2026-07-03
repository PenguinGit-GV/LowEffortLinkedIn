// Post sharing expiry — new feature (was listed as future/out-of-scope in
// PLAN.md §13, now implemented). expires_at is computed at /create-post time
// from the marketer's chosen window or DEFAULT_POST_EXPIRY_HOURS. expired_at
// is stamped by the post-expiry job once it has removed the Share buttons
// from the card, so the job is idempotent and re-runnable.

exports.up = async function up(knex) {
  await knex.schema.alterTable('posts', (t) => {
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('expired_at', { useTz: true });
  });
  // Powers the post-expiry job's "what's due" scan.
  await knex.raw(
    `CREATE INDEX idx_posts_expires_at ON posts(expires_at) WHERE expired_at IS NULL`
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_posts_expires_at');
  await knex.schema.alterTable('posts', (t) => {
    t.dropColumn('expires_at');
    t.dropColumn('expired_at');
  });
};
