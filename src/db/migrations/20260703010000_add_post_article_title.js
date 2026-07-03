// LinkedIn's live Posts API requires content.article.title (PLAN.md §10's
// schema-drift risk, confirmed live). It's resolved once at /create-post time
// from the destination page's real <title> (falling back to the hostname on
// any fetch failure) and reused by every share of that post.
//
// notNullable + a default backfills any pre-existing rows with '' rather than
// failing the migration; the share pipeline's own hostname fallback (§4)
// covers a post that somehow still has an empty title at share time.

exports.up = async function up(knex) {
  await knex.schema.alterTable('posts', (t) => {
    t.text('article_title').notNullable().defaultTo('');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('posts', (t) => {
    t.dropColumn('article_title');
  });
};
