// Health check + restart — plans/env-var-ui-feature-spec.md Phase 3.
//
// Restart note (spec Finding F3, downgraded to "document, don't build"): a
// single Railway service instance has no zero-downtime restart story. This
// endpoint discloses that in its own response rather than pretending
// otherwise — it is not graceful in the sense of avoiding an outage window,
// only in the sense of returning a response before exiting.

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

function registerAdminOps(router, { config, db, slackClient, logger = console }) {
  const auth = requireAdminSession(config);

  router.get('/admin/api/health', auth, async (_req, res) => {
    const [dbStatus, slackStatus] = await Promise.all([probeDb(db), probeSlack(slackClient)]);
    res.json({ db: dbStatus, slack: slackStatus, linkedin: probeLinkedin(config) });
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

module.exports = { registerAdminOps, probeDb, probeSlack, probeLinkedin };
