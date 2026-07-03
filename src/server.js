const { App, ExpressReceiver } = require('@slack/bolt');

const { registerCreatePost } = require('./handlers/createPost');
const { registerDisconnect } = require('./handlers/disconnect');
const { registerShareHandlers } = require('./handlers/share');
const { registerStats } = require('./handlers/stats');
const { registerAuthRoutes } = require('./routes/auth');
const { registerConnectPromptAction } = require('./slack/connectPrompt');
const { createShareClient } = require('./linkedin/posts');
const { registerAdminAuthRoutes } = require('./admin/auth');
const { registerAdminApi } = require('./admin/api');
const { registerAdminPages } = require('./admin/pages');
const { registerAdminOps } = require('./admin/ops');
const { createReloadController } = require('./admin/reload');
const { createBoundedSlackClient, BOUNDED_RETRY_CONFIG } = require('./slack/client');

// Builds the Bolt app on an ExpressReceiver so the LinkedIn OAuth routes
// and /healthz share the single HTTP server (PLAN.md §3).
// Slack handlers (Phase 2/4/5) and auth routes (Phase 3) register here.
//
// overrides.authorize lets tests supply a static authorization and skip the
// auth.test call Bolt otherwise makes against the real Slack API;
// overrides.logLevel quiets Bolt's logger in tests; overrides.slackClient and
// overrides.linkedin let tests stub the OAuth routes' outbound calls.
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
    // Bolt's per-handler client (the `client` every action/command/view
    // handler receives) otherwise ships @slack/web-api's default retry
    // policy — ten retries over ~30 minutes. During a Slack incident that
    // would pin a share pipeline (and its in-flight dedupe lock) for the
    // whole outage; bound it like every other Slack client in this app.
    clientOptions: { retryConfig: BOUNDED_RETRY_CONFIG },
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

  registerCreatePost(app, { config, db });
  registerShareHandlers(app, {
    config,
    db,
    shareClient: overrides.shareClient || createShareClient(config),
    ...(overrides.fetchFile ? { fetchFile: overrides.fetchFile } : {}),
  });
  registerDisconnect(app, { db });
  registerStats(app, { db });
  registerConnectPromptAction(app);
  // Dedicated client for the non-Bolt call sites (OAuth notifications, the
  // admin health probe) — same bounded retry policy as everything else.
  const slackClient = overrides.slackClient || createBoundedSlackClient(config.slackBotToken);
  registerAuthRoutes(receiver.router, {
    config,
    db,
    slackClient,
    linkedin: overrides.linkedin,
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  });

  // Feature-flagged (plans/env-var-ui-feature-spec.md): most deployments
  // haven't set up the Sign-in-with-Slack app credentials this needs yet.
  if (config.adminUiEnabled) {
    registerAdminAuthRoutes(receiver.router, {
      config,
      openId: overrides.adminOpenId,
      ...(overrides.logger ? { logger: overrides.logger } : {}),
    });
    // envConfig is the pristine, never-mutated boot-time config
    // (index.js keeps its own reference); jobs is the mutable cron-task
    // holder the reload controller stops/restarts. Both default to
    // something inert so tests that don't care about hot-reload still work.
    const reloadController = createReloadController({
      config,
      db,
      jobs: overrides.jobs || {},
      ...(overrides.logger ? { logger: overrides.logger } : {}),
    });
    registerAdminApi(receiver.router, {
      config,
      db,
      envConfig: overrides.envConfig,
      reloadController,
      ...(overrides.logger ? { logger: overrides.logger } : {}),
    });
    registerAdminPages(receiver.router, { config });
    registerAdminOps(receiver.router, {
      config,
      db,
      slackClient,
      ...(overrides.logger ? { logger: overrides.logger } : {}),
    });
  }

  app.error(async (err) => {
    console.error('Unhandled handler error:', err);
  });

  return { app, receiver };
}

module.exports = { createServer };
