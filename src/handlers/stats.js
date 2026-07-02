// /advocacy-stats — ephemeral leaderboard (PLAN.md §2.5).
// Anyone can run it; optional integer argument sets the day window
// (clamped 1–365, anything unparsable falls back to 30). Top 10 sharers by
// successful shares in the window plus a total line (copy C11).

const copy = require('../copy');

const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const TOP_N = 10;

function parseWindowDays(text) {
  const n = Number.parseInt((text || '').trim(), 10);
  if (!Number.isInteger(n)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, n));
}

// → { total, leaders: [{ slack_user_id, count }] } over the window.
async function fetchLeaderboard(db, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const base = () => db('shares').where('status', 'success').where('shared_at', '>=', since);

  const [{ count: total }] = await base().count();
  const leaders = await base()
    .select('slack_user_id')
    .count('* as count')
    .groupBy('slack_user_id')
    .orderBy('count', 'desc')
    .orderBy('slack_user_id', 'asc') // deterministic tie-break
    .limit(TOP_N);

  return {
    total: Number(total),
    leaders: leaders.map((row) => ({
      slack_user_id: row.slack_user_id,
      count: Number(row.count),
    })),
  };
}

function formatLeaderboard(days, { total, leaders }) {
  const header = copy.C11_HEADER(days, total);
  if (leaders.length === 0) return `${header}\n${copy.C11_EMPTY}`;
  const lines = leaders.map(
    ({ slack_user_id, count }, i) =>
      `${i + 1}. <@${slack_user_id}> — ${count} share${count === 1 ? '' : 's'}`
  );
  return [header, ...lines].join('\n');
}

function registerStats(app, { db }) {
  app.command('/advocacy-stats', async ({ command, ack, respond, logger }) => {
    await ack();
    try {
      const days = parseWindowDays(command.text);
      const board = await fetchLeaderboard(db, days);
      await respond({ response_type: 'ephemeral', text: formatLeaderboard(days, board) });
    } catch (err) {
      logger.error('/advocacy-stats failed', err);
      await respond({
        response_type: 'ephemeral',
        text: '😕 Could not load the leaderboard — please try again.',
      });
    }
  });
}

module.exports = {
  registerStats,
  parseWindowDays,
  fetchLeaderboard,
  formatLeaderboard,
  DEFAULT_WINDOW_DAYS,
};
