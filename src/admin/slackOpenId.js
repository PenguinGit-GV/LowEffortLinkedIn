// Sign-in-with-Slack (OpenID Connect) — admin UI login.
// https://api.slack.com/authentication/sign-in-with-slack
//
// Deliberately a separate app-level OAuth flow from the LinkedIn one in
// src/linkedin/oauth.js: it authenticates the *operator* opening the admin
// UI in a browser, not a marketer connecting their LinkedIn account.

const axios = require('axios');

const AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const USERINFO_URL = 'https://slack.com/api/openid.connect.userInfo';
const HTTP_TIMEOUT_MS = 10_000;

function callbackUrl(config) {
  return `${config.publicBaseUrl}/admin/login/callback`;
}

function buildAuthorizeUrl(config, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.slackClientId,
    scope: 'openid',
    redirect_uri: callbackUrl(config),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// -> access_token for the userinfo call below.
async function exchangeCodeForToken(config, code) {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      client_id: config.slackClientId,
      client_secret: config.slackClientSecret,
      code,
      redirect_uri: callbackUrl(config),
    }).toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: HTTP_TIMEOUT_MS,
    }
  );
  if (!res.data.ok) {
    throw new Error(`openid.connect.token failed: ${res.data.error || 'unknown error'}`);
  }
  return res.data.access_token;
}

// -> the Slack user ID (`sub`, per Slack's OIDC implementation) or null.
async function fetchSlackUserId(accessToken) {
  const res = await axios.get(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: HTTP_TIMEOUT_MS,
  });
  if (!res.data.ok) {
    throw new Error(`openid.connect.userInfo failed: ${res.data.error || 'unknown error'}`);
  }
  return res.data.sub || res.data['https://slack.com/user_id'] || null;
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, fetchSlackUserId };
