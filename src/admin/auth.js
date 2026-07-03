// Admin login — "Sign in with Slack" (OpenID Connect) — plans/env-var-ui-feature-spec.md.
// Gates the config UI on config.marketerSlackIds, the same allow-list
// /create-post already uses. overrides.openId lets tests stub the Slack HTTP
// calls.

const { signToken, verifyToken } = require('../crypto/signedToken');
const defaultOpenId = require('./slackOpenId');
const { setSessionCookie, clearSessionCookie, readSession } = require('./session');

const STATE_TTL_SECONDS = 10 * 60;
// Distinct purpose from the LinkedIn connect flow's 'state' tokens (both
// happen to use HMAC secrets, but never the same secret — see session.js).
const STATE_PURPOSE = 'admin_login_state';

function registerAdminAuthRoutes(router, { config, logger = console, openId = defaultOpenId }) {
  router.get('/admin/login', (_req, res) => {
    const state = signToken({ purpose: STATE_PURPOSE }, config.adminSessionSecret, STATE_TTL_SECONDS);
    res.redirect(302, openId.buildAuthorizeUrl(config, state));
  });

  router.get('/admin/login/callback', async (req, res) => {
    try {
      if (req.query.error) {
        res.status(400).send('Sign-in was cancelled or denied.');
        return;
      }
      const statePayload = verifyToken(req.query.state, config.adminSessionSecret, STATE_PURPOSE);
      if (!statePayload || !req.query.code) {
        res.status(400).send('This sign-in link has expired. Go back and try again.');
        return;
      }

      const accessToken = await openId.exchangeCodeForToken(config, req.query.code);
      const slackUserId = await openId.fetchSlackUserId(accessToken);
      if (!slackUserId || !config.marketerSlackIds.includes(slackUserId)) {
        res.status(403).send('Your Slack account is not authorized to manage configuration.');
        return;
      }

      setSessionCookie(res, config, slackUserId);
      res.redirect(302, '/admin');
    } catch (err) {
      logger.error('GET /admin/login/callback failed:', err);
      res.status(502).send('Sign-in failed. Please try again.');
    }
  });

  router.post('/admin/logout', (_req, res) => {
    clearSessionCookie(res, config);
    res.redirect(302, '/admin/login');
  });
}

// Applied to every /admin/* route except /admin/login*. JSON APIs get a 401;
// browser navigations get redirected to the login page.
function requireAdminSession(config) {
  return (req, res, next) => {
    const session = readSession(req, config);
    if (!session || !config.marketerSlackIds.includes(session.slack_user_id)) {
      if (req.path.startsWith('/admin/api/')) {
        res.status(401).json({ error: 'not authenticated' });
      } else {
        res.redirect(302, '/admin/login');
      }
      return;
    }
    req.adminSlackUserId = session.slack_user_id;
    next();
  };
}

// Finding F6: a cross-site HTML form can't set a custom Content-Type of
// application/json, and SameSite=Strict already blocks the session cookie
// from riding along on a cross-site top-level navigation anyway — the two
// together are a cheap, effective CSRF mitigation without a dedicated token
// for what is a JSON-only API surface.
function requireJsonContentType(req, res, next) {
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'Content-Type must be application/json' });
    return;
  }
  next();
}

module.exports = { registerAdminAuthRoutes, requireAdminSession, requireJsonContentType };
