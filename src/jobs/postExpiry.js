// Post sharing expiry — new feature (was future/out-of-scope in PLAN.md
// §13). Once a post's sharing window (set at /create-post time from the
// marketer's chosen hours, or DEFAULT_POST_EXPIRY_HOURS) has passed, this
// job strips the Share/Edit buttons off the card. The message and its share
// counter stay visible — only future sharing is closed off. The share
// pipeline (src/handlers/share.js) independently rejects expired posts too,
// so a click landing in the gap between cron runs is still blocked; this job
// is what makes that visible on the card itself.

const cron = require('node-cron');
const { WebClient } = require('@slack/web-api');
const { buildPostCard } = require('../blocks/postCard');
const { loadPostCards } = require('../db/postCards');

// Due = past its window, still has a live card, and hasn't been closed out
// yet (expired_at is the idempotency stamp — set only after a successful
// chat.update, mirroring the token-reminder job's pattern).
function findPostsToExpire(db, now = new Date()) {
  return db('posts')
    .whereNotNull('expires_at')
    .whereNull('expired_at')
    .where('expires_at', '<=', now)
    .whereNotNull('slack_channel_id')
    .whereNotNull('slack_message_ts');
}

// One pass of the job. A post can have been broadcast to several channels, so
// every card is stripped of its buttons. The stamp is written only after all
// of a post's cards update successfully, so a partial failure retries the
// whole post on the next run (chat.update is idempotent); one post's failure
// never blocks the rest.
async function runPostExpiry({ db, slackClient, logger = console }, now = new Date()) {
  const due = await findPostsToExpire(db, now);
  let closed = 0;
  for (const post of due) {
    try {
      const [{ count }] = await db('shares')
        .where({ post_id: post.id, status: 'success' })
        .count();
      const cards = await loadPostCards(db, post);
      // expired_at is only a local render hint here — the DB write below is
      // what actually makes the state durable.
      const blocks = buildPostCard({ post: { ...post, expired_at: now }, shareCount: Number(count) });
      let allClosed = cards.length > 0;
      for (const card of cards) {
        try {
          await slackClient.chat.update({
            channel: card.slack_channel_id,
            ts: card.slack_message_ts,
            text: `New post ready to share: ${post.destination_url}`,
            blocks,
          });
        } catch (err) {
          allClosed = false;
          logger.error(
            `Post expiry close failed for post ${post.id} card ${card.slack_channel_id}: ` +
              `${err.data?.error || err.message}`
          );
        }
      }
      if (allClosed) {
        await db('posts').where({ id: post.id }).update({ expired_at: db.fn.now() });
        closed += 1;
      }
    } catch (err) {
      logger.error(
        `Post expiry close failed for post ${post.id}: ${err.data?.error || err.message}`
      );
    }
  }
  // .info(), not .log() — logger defaults to console, but the real Bolt
  // Logger (no .log) works here too if a future change ever passes it in.
  if (due.length > 0) logger.info(`Post expiry: ${closed}/${due.length} cards closed`);
  return { due: due.length, closed };
}

// Schedules the frequent run (config.postExpiryCron, UTC) — expiry windows
// are hours-scale, so this needs finer granularity than the daily token
// reminder. Returns the task so the caller can stop() it on shutdown.
function startPostExpiryJob({ config, db, logger = console }, overrides = {}) {
  const cronLib = overrides.cronLib || cron;
  if (!cronLib.validate(config.postExpiryCron)) {
    throw new Error(`POST_EXPIRY_CRON is not a valid cron expression: "${config.postExpiryCron}"`);
  }
  const slackClient =
    overrides.slackClient ||
    new WebClient(config.slackBotToken, {
      retryConfig: { retries: 2, minTimeout: 500, maxTimeout: 2000 },
    });

  return cronLib.schedule(
    config.postExpiryCron,
    () => {
      runPostExpiry({ db, slackClient, logger }).catch((err) =>
        logger.error('Post expiry job failed:', err)
      );
    },
    { timezone: 'Etc/UTC' }
  );
}

module.exports = { findPostsToExpire, runPostExpiry, startPostExpiryJob };
