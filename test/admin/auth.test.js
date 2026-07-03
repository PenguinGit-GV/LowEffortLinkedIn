// Sign-in-with-Slack admin login flow + session/CSRF middleware —
// plans/env-var-ui-feature-spec.md.

const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createServer } = require('../../src/server');
const { signToken } = require('../../src/crypto/signedToken');
const { fakeAdminDb } = require('./fakeAdminDb');

const ADMIN_SESSION_SECRET = 'admin-session-secret';

function testConfig(extra = {}) {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111,U222',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
    ADMIN_UI_ENABLED: 'true',
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    ADMIN_SESSION_SECRET,
    ...extra,
  });
}

const baseOverrides = {
  authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
  logLevel: 'error',
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
};

function buildApp({ config, adminOpenId }) {
  const { db } = fakeAdminDb();
  const { receiver } = createServer(config, db, { ...baseOverrides, adminOpenId });
  return request(receiver.app);
}

function sessionCookieFor(slackUserId) {
  const token = signToken(
    { slack_user_id: slackUserId, purpose: 'admin_session' },
    ADMIN_SESSION_SECRET,
    12 * 60 * 60
  );
  return `admin_session=${encodeURIComponent(token)}`;
}

describe('GET /admin/login', () => {
  test('redirects to Slack OpenID authorize with a signed state', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent.get('/admin/login');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('scope')).toBe('openid');
    expect(location.searchParams.get('state')).toBeTruthy();
  });
});

describe('GET /admin/login/callback', () => {
  test('rejects a Slack account not in MARKETER_SLACK_IDS', async () => {
    const adminOpenId = {
      exchangeCodeForToken: jest.fn().mockResolvedValue('slack-access-token'),
      fetchSlackUserId: jest.fn().mockResolvedValue('U_NOT_A_MARKETER'),
    };
    const agent = buildApp({ config: testConfig(), adminOpenId });
    const state = signToken({ purpose: 'admin_login_state' }, ADMIN_SESSION_SECRET, 600);
    const res = await agent.get(`/admin/login/callback?code=abc&state=${state}`);
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('rejects a missing/expired state token', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent.get('/admin/login/callback?code=abc&state=garbage');
    expect(res.status).toBe(400);
  });

  test('accepts a denied-consent redirect from Slack without crashing', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent.get('/admin/login/callback?error=access_denied');
    expect(res.status).toBe(400);
  });

  test('sets a session cookie and redirects to /admin for an authorized marketer', async () => {
    const adminOpenId = {
      exchangeCodeForToken: jest.fn().mockResolvedValue('slack-access-token'),
      fetchSlackUserId: jest.fn().mockResolvedValue('U111'),
    };
    const agent = buildApp({ config: testConfig(), adminOpenId });
    const state = signToken({ purpose: 'admin_login_state' }, ADMIN_SESSION_SECRET, 600);
    const res = await agent.get(`/admin/login/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain('admin_session=');
    expect(cookie).toContain('HttpOnly');
    // Lax, not Strict: Strict withholds the cookie on the OAuth callback's
    // own trailing redirect to /admin (the redirect chain started cross-site
    // at slack.com), which loops the admin back into another Slack consent
    // screen instead of landing them on the dashboard.
    expect(cookie).toContain('SameSite=Lax');
  });

  test('a state token is single-use — replaying it within its TTL is rejected', async () => {
    const adminOpenId = {
      exchangeCodeForToken: jest.fn().mockResolvedValue('slack-access-token'),
      fetchSlackUserId: jest.fn().mockResolvedValue('U111'),
    };
    const agent = buildApp({ config: testConfig(), adminOpenId });
    const state = signToken({ purpose: 'admin_login_state' }, ADMIN_SESSION_SECRET, 600);
    const first = await agent.get(`/admin/login/callback?code=abc&state=${state}`);
    expect(first.status).toBe(302);
    const replay = await agent.get(`/admin/login/callback?code=abc&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.headers['set-cookie']).toBeUndefined();
  });
});

describe('requireAdminSession (via /admin/api/config)', () => {
  test('401s a JSON API request with no session cookie', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent.get('/admin/api/config');
    expect(res.status).toBe(401);
  });

  test('401s a session cookie for a Slack ID no longer in MARKETER_SLACK_IDS', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent
      .get('/admin/api/config')
      .set('Cookie', sessionCookieFor('U_REVOKED'));
    expect(res.status).toBe(401);
  });

  test('allows a valid marketer session through', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent.get('/admin/api/config').set('Cookie', sessionCookieFor('U111'));
    expect(res.status).toBe(200);
  });

  test('a malformed %-escape in a cookie reads as "not authenticated", not a 500', async () => {
    // decodeURIComponent throws a URIError on values like "%zz"; any other
    // app on the same domain can plant such a cookie. It must not turn
    // every /admin request into a 500 until the user clears cookies.
    const agent = buildApp({ config: testConfig() });
    const res = await agent
      .get('/admin/api/config')
      .set('Cookie', 'some_other_app=%zz; admin_session=%zz');
    expect(res.status).toBe(401);
  });
});

describe('requireJsonContentType (CSRF mitigation, F6)', () => {
  test('rejects a form-encoded PUT (the shape a cross-site <form> could send)', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent
      .put('/admin/api/config/PUBLIC_BASE_URL')
      .set('Cookie', sessionCookieFor('U111'))
      .type('form')
      .send({ value: 'https://evil.example.com' });
    expect(res.status).toBe(415);
  });

  test('accepts a JSON PUT with a valid session', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent
      .put('/admin/api/config/PUBLIC_BASE_URL')
      .set('Cookie', sessionCookieFor('U111'))
      .send({ value: 'https://new-domain.up.railway.app' });
    expect(res.status).toBe(200);
  });
});

describe('POST /admin/logout', () => {
  test('clears the session cookie', async () => {
    const agent = buildApp({ config: testConfig() });
    const res = await agent.post('/admin/logout').set('Cookie', sessionCookieFor('U111'));
    expect(res.status).toBe(302);
    expect(res.headers['set-cookie'][0]).toContain('Max-Age=0');
  });
});
