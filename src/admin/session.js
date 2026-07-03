// Admin session cookie — a signed, stateless token (reusing the existing
// signToken/verifyToken HMAC scheme), not a DB-backed session store. Scoped
// to ADMIN_SESSION_SECRET specifically (not OAUTH_STATE_SECRET) so rotating
// one doesn't log out admins or invalidate in-flight LinkedIn connect links.

const { signToken, verifyToken } = require('../crypto/signedToken');

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(value);
    } catch {
      // A malformed %-escape (any other app on the domain can plant one)
      // must read as "no such cookie" — not a URIError that 500s every
      // /admin route until the user clears their cookies.
    }
    return acc;
  }, {});
}

// HttpOnly (no JS access) + SameSite=Lax + Secure in production (Railway is
// always HTTPS; local dev over http would silently drop a Secure cookie).
//
// Lax, not Strict: the Sign-in-with-Slack callback lands via a cross-site
// redirect chain (slack.com -> .../admin/login/callback -> .../admin), and
// browsers key "site for cookies" off where a redirect chain started, not
// each individual hop — so a Strict cookie set mid-chain is stored but
// withheld on that chain's own trailing redirect to /admin, bouncing the
// admin straight back into another Slack consent screen (confirmed: this
// shipped as Strict and produced exactly that login loop). Lax still
// withholds the cookie on cross-site POST/PUT/DELETE, which is what
// actually matters for CSRF on the mutating admin API; the real mitigation
// there is requireJsonContentType (spec Finding F6) below, which a
// cross-site <form> can't satisfy regardless of SameSite.
function cookieAttrs(config, extra = []) {
  const attrs = ['Path=/admin', 'HttpOnly', 'SameSite=Lax', ...extra];
  if (config.nodeEnv === 'production') attrs.push('Secure');
  return attrs;
}

function setSessionCookie(res, config, slackUserId) {
  const token = signToken(
    { slack_user_id: slackUserId, purpose: 'admin_session' },
    config.adminSessionSecret,
    SESSION_TTL_SECONDS
  );
  res.set(
    'Set-Cookie',
    [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, ...cookieAttrs(config)].join('; ')
  );
}

function clearSessionCookie(res, config) {
  res.set('Set-Cookie', [`${SESSION_COOKIE}=`, ...cookieAttrs(config, ['Max-Age=0'])].join('; '));
}

// -> the verified { slack_user_id, ... } payload, or null.
function readSession(req, config) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return verifyToken(token, config.adminSessionSecret, 'admin_session');
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  readSession,
};
