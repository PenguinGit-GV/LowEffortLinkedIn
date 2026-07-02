const { App, ExpressReceiver } = require('@slack/bolt');

// Builds the Bolt app on an ExpressReceiver so the LinkedIn OAuth routes
// (Phase 3) and /healthz share the single HTTP server (PLAN.md §3).
// Slack handlers (Phase 2/4/5) and auth routes (Phase 3) register here.
//
// overrides.authorize lets tests supply a static authorization and skip the
// auth.test call Bolt otherwise makes against the real Slack API;
// overrides.logLevel quiets Bolt's logger in tests.
function createServer(config, db, overrides = {}) {
  const receiver = new ExpressReceiver({
    signingSecret: config.slackSigningSecret,
    endpoints: '/slack/events',
    ...(overrides.logLevel ? { logLevel: overrides.logLevel } : {}),
  });

  const app = new App({
    receiver,
    ...(overrides.authorize
      ? { authorize: overrides.authorize }
      : { token: config.slackBotToken }),
    ...(overrides.logLevel ? { logLevel: overrides.logLevel } : {}),
  });

  receiver.router.get('/healthz', async (_req, res) => {
    try {
      // Bounded probe: without the timeout, an unreachable-but-not-refusing DB
      // would hang this request for knex's 60s acquire timeout, which reads as
      // a dead service to platform healthcheckers.
      await db.raw('select 1').timeout(2000, { cancel: true });
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  return { app, receiver };
}

module.exports = { createServer };
