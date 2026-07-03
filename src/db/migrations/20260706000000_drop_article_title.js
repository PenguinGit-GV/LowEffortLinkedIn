// Removes posts.article_title — the follow-up PLAN.md §4 explicitly flagged.
// The column existed for the old `content.article.title` payload shape; since
// the switch to letting LinkedIn's own crawler unfurl the URL from the
// commentary text, the value was fetched (a ~5s outbound request per
// /create-post) and stored but never read by anything: not the LinkedIn
// payload, not the Slack card. The fetcher (src/linkedin/pageTitle.js) and
// its SSRF guard are deleted in the same change.

exports.up = async function up(knex) {
  await knex.schema.alterTable('posts', (t) => {
    t.dropColumn('article_title');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('posts', (t) => {
    t.text('article_title').notNullable().defaultTo('');
  });
};
