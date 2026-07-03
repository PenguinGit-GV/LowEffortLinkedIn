// Token expiry reminder — PLAN.md §11 Phase 6, Decision #7.
// LinkedIn tokens in this flow aren't refreshable; without a nudge the Share
// button silently breaks after 60 days. A daily job DMs anyone whose token
// expires within 7 days (copy C5 + a reconnect button) and stamps
// expiry_reminder_sent_at so they're reminded once per token. Reconnecting
// clears the stamp (§2.2 step 4), which re-arms the reminder for the fresh
// token's window.

const cron = require('node-cron');
const { WebClient } = require('@slack/web-api');

const copy = require('../copy');
const { buildConnectUrl } = require('./../slack/connectPrompt');

const REMINDER_WINDOW_DAYS = 7;
// The DM sits in an inbox, so its reconnect link outlives the token itself
// (2× the reminder window) — a late reader still gets a working button,
// unlike the in-the-moment C1 link (15 min). The token only permits binding
// the recipient's own Slack ID, so the longer life adds no attack surface.
const REMINDER_LINK_TTL_SECONDS = 2 * REMINDER_WINDOW_DAYS * 24 * 60 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Users with a live connection expiring inside the window who haven't been
// reminded for THIS token: stamp is null (cleared on reconnect), or — the
// §11 belt-and-braces case — predates the current token's reminder window.
function findUsersNeedingReminder(db, now = new Date()) {
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * MS_PER_DAY);
  return db('users')
    .whereNotNull('linkedin_access_token')
    .whereNotNull('token_expires_at')
    .where('token_expires_at', '>', now)
    .where('token_expires_at', '<=', windowEnd)
    .where(function () {
      this.whereNull('expiry_reminder_sent_at').orWhereRaw(
        `expiry_reminder_sent_at < token_expires_at - interval '${REMINDER_WINDOW_DAYS} days'`
      );
    });
}

function buildReminderBlocks(config, user, days) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: copy.C5(days) } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Reconnect LinkedIn' },
          url: buildConnectUrl(config, user.slack_user_id, REMINDER_LINK_TTL_SECONDS),
          action_id: 'connect_linkedin', // no-op ack already registered
        },
      ],
    },
  ];
}

// One pass of the job. The stamp is written only after the DM succeeds, so a
// failed DM retries on the next daily run; one user's failure never blocks
// the rest.
async function runExpiryReminder({ db, config, slackClient, logger = console }, now = new Date()) {
  const due = await findUsersNeedingReminder(db, now);
  let sent = 0;
  for (const user of due) {
    const days = Math.max(
      1,
      Math.ceil((new Date(user.token_expires_at).getTime() - now.getTime()) / MS_PER_DAY)
    );
    try {
      await slackClient.chat.postMessage({
        channel: user.slack_user_id,
        text: copy.C5(days),
        blocks: buildReminderBlocks(config, user, days),
      });
      await db('users').where({ slack_user_id: user.slack_user_id }).update({
        expiry_reminder_sent_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
      sent += 1;
    } catch (err) {
      logger.error(
        `Expiry reminder DM to ${user.slack_user_id} failed: ${err.data?.error || err.message}`
      );
    }
  }
  // .info(), not .log() — logger defaults to console, but the real Bolt
  // Logger (no .log) works here too if a future change ever passes it in.
  if (due.length > 0) logger.info(`Expiry reminders: ${sent}/${due.length} sent`);
  return { due: due.length, sent };
}

// Schedules the daily run (config.reminderCron, UTC). Returns the task so the
// caller can stop() it on shutdown. overrides let tests stub cron and Slack.
function startExpiryReminderJob({ config, db, logger = console }, overrides = {}) {
  const cronLib = overrides.cronLib || cron;
  if (!cronLib.validate(config.reminderCron)) {
    throw new Error(`REMINDER_CRON is not a valid cron expression: "${config.reminderCron}"`);
  }
  const slackClient =
    overrides.slackClient ||
    new WebClient(config.slackBotToken, {
      // Bounded like the OAuth routes' client — a Slack outage shouldn't pin
      // a job run for half an hour.
      retryConfig: { retries: 2, minTimeout: 500, maxTimeout: 2000 },
    });

  return cronLib.schedule(
    config.reminderCron,
    () => {
      runExpiryReminder({ db, config, slackClient, logger }).catch((err) =>
        logger.error('Expiry reminder job failed:', err)
      );
    },
    { timezone: 'Etc/UTC' }
  );
}

module.exports = {
  findUsersNeedingReminder,
  runExpiryReminder,
  startExpiryReminderJob,
  buildReminderBlocks,
  REMINDER_WINDOW_DAYS,
  REMINDER_LINK_TTL_SECONDS,
};
