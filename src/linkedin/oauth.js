// LinkedIn OAuth HTTP calls — PLAN.md §4.
// Scopes are the current "Sign In with LinkedIn using OpenID Connect" +
// "Share on LinkedIn" products; the identity lookup is the OIDC userinfo
// endpoint whose `sub` claim is the member's URN id.

const axios = require('axios');

const AUTHORIZATION_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const OAUTH_SCOPES = 'openid profile w_member_social';

const HTTP_TIMEOUT_MS = 10_000;

function buildAuthorizationUrl(config, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.linkedinClientId,
    redirect_uri: config.linkedinRedirectUri,
    state,
    scope: OAUTH_SCOPES,
  });
  return `${AUTHORIZATION_URL}?${params.toString()}`;
}

// → { accessToken, expiresIn } (expiresIn in seconds, ~60 days).
async function exchangeCodeForToken(config, code) {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.linkedinClientId,
      client_secret: config.linkedinClientSecret,
      redirect_uri: config.linkedinRedirectUri,
    }).toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: HTTP_TIMEOUT_MS,
    }
  );
  return { accessToken: res.data.access_token, expiresIn: res.data.expires_in };
}

// → OIDC claims; `sub` is stored as users.linkedin_person_id.
async function fetchUserInfo(accessToken) {
  const res = await axios.get(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: HTTP_TIMEOUT_MS,
  });
  return res.data;
}

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  OAUTH_SCOPES,
  AUTHORIZATION_URL,
};
