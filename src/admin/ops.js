// Health check + restart — plans/env-var-ui-feature-spec.md Phase 3.
//
// Restart note (spec Finding F3, downgraded to "document, don't build"): a
// single Railway service instance has no zero-downtime restart story. This
// endpoint discloses that in its own response rather than pretending
// otherwise — it is not graceful in the sense of avoiding an outage window,
// only in the sense of returning a response before exiting.
//
// Environment name (Finding F4): the roadmap's original Phase 4.1 asked for
// live switching between Railway environments from one running instance.
// That needs the OTHER environment's DATABASE_URL (and likely its
// TOKEN_ENCRYPTION_KEY) available somewhere — the exact bootstrap-secret
// problem the allow-list exists to avoid. Descoped to a read-only label
// naming which environment THIS instance is running as, sourced from
// Railway's own injected variable.

const { requireAdminSession } = require('./auth');

async function probeDb(db) {
  try {
    await db.raw('select 1').timeout(2000, { cancel: true });
    return 'up';
  } catch {
    return 'down';
  }
}

async function probeSlack(slackClient) {
  try {
    const result = await slackClient.auth.test();
    return result.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

// LinkedIn has no lightweight unauthenticated ping endpoint — this reports
// configuration state, not live connectivity, which is enough to catch the
// "forgot to set the client secret after flipping mock mode off" class of
// mistake this UI exists to prevent.
function probeLinkedin(config) {
  if (config.linkedinMockMode) return 'mock';
  return config.linkedinClientId && config.linkedinClientSecret ? 'configured' : 'not configured';
}

// Railway injects RAILWAY_ENVIRONMENT_NAME; config.nodeEnv is the fallback
// for non-Railway (e.g. local dev) deployments.
function currentEnvironmentName(config) {
  return process.env.RAILWAY_ENVIRONMENT_NAME || config.nodeEnv;
}

function registerAdminOps(router, { config, db, slackClient, logger = console }) {
  const auth = requireAdminSession(config);

  router.get('/admin/api/health', auth, async (_req, res) => {
    const [dbStatus, slackStatus] = await Promise.all([probeDb(db), probeSlack(slackClient)]);
    res.json({
      db: dbStatus,
      slack: slackStatus,
      linkedin: probeLinkedin(config),
      environment: currentEnvironmentName(config),
    });
  });

  router.post('/admin/api/restart', auth, (req, res) => {
    logger.info(`Admin restart requested by ${req.adminSlackUserId}`);
    res.json({
      ok: true,
      message: 'Restarting now — the app will be briefly unavailable while the platform relaunches it.',
    });
    // Let the response flush before exiting; Railway's restart policy brings
    // the container back up with the now-persisted config.
    setImmediate(() => process.exit(0));
  });
}

module.exports = { registerAdminOps, probeDb, probeSlack, probeLinkedin, currentEnvironmentName };
