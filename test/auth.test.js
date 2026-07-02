// Route-level tests for the LinkedIn OAuth pipeline (PLAN.md §12):
// /auth/linkedin redirect + 4xx on unsigned requests, the callback's deny/
// verify/exchange/upsert path, and mock mode's local handshake.

const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');
const { signToken, verifyToken } = require('../src/crypto/signedToken');
const { decryptToken } = require('../src/crypto/tokenCipher');

const STATE_SECRET = 'state-secret';
const ENCRYPTION_KEY = Buffer.alloc(32, 7);

function testConfig(extra = {}) {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: STATE_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY.toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
    ...extra,
  });
}

function realModeConfig() {
  return testConfig({
    LINKEDIN_MOCK_MODE: 'false',
    LINKEDIN_CLIENT_ID: 'client-id',
    LINKEDIN_CLIENT_SECRET: 'client-secret',
    LINKEDIN_REDIRECT_URI: 'https://example.up.railway.app/auth/linkedin/callback',
  });
}

// Stub knex: records users upserts, and satisfies the /healthz probe shape.
function stubDb() {
  const upserts = [];
  const db = jest.fn((table) => ({
    insert: (row) => ({
      onConflict: () => ({
        merge: async () => {
          upserts.push({ table, row });
        },
      }),
    }),
  }));
  db.raw = jest.fn(() => ({ timeout: jest.fn().mockResolvedValue([]) }));
  db.fn = { now: () => new Date() };
  return { db, upserts };
}

function stubSlackClient() {
  return { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } };
}

const testOverrides = {
  authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
  logLevel: 'error',
  // Exchange failures and DM failures are exercised on purpose; keep them
  // out of the test output.
  logger: { error: jest.fn(), warn: jest.fn() },
};

function buildApp({ config, linkedin }) {
  const { db, upserts } = stubDb();
  const slackClient = stubSlackClient();
  const { receiver } = createServer(config, db, {
    ...testOverrides,
    slackClient,
    linkedin,
  });
  return { agent: request(receiver.app), upserts, slackClient };
}

function connectToken(slackUserId, { secret = STATE_SECRET, ttl = 900 } = {}) {
  return signToken({ slack_user_id: slackUserId, purpose: 'connect' }, secret, ttl);
}

function stateToken(slackUserId, { secret = STATE_SECRET, ttl = 600 } = {}) {
  return signToken({ slack_user_id: slackUserId, purpose: 'state' }, secret, ttl);
}

describe('GET /auth/linkedin', () => {
  test('rejects a missing token with the P3 page', async () => {
    const { agent } = buildApp({ config: testConfig() });
    const res = await agent.get('/auth/linkedin');
    expect(res.status).toBe(400);
    expect(res.text).toContain('This link has expired');
  });

  test('rejects a token signed with the wrong secret', async () => {
    const { agent } = buildApp({ config: testConfig() });
    const res = await agent
      .get('/auth/linkedin')
      .query({ token: connectToken('U777', { secret: 'wrong' }) });
    expect(res.status).toBe(400);
  });

  test('rejects an expired connect token', async () => {
    const { agent } = buildApp({ config: testConfig() });
    const res = await agent
      .get('/auth/linkedin')
      .query({ token: connectToken('U777', { ttl: -1 }) });
    expect(res.status).toBe(400);
  });

  test('rejects a state token used as a connect link (purpose confusion)', async () => {
    const { agent } = buildApp({ config: testConfig() });
    const res = await agent.get('/auth/linkedin').query({ token: stateToken('U777') });
    expect(res.status).toBe(400);
  });

  test('redirects to LinkedIn with a signed state (real mode)', async () => {
    const { agent, upserts } = buildApp({ config: realModeConfig() });
    const res = await agent.get('/auth/linkedin').query({ token: connectToken('U777') });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(
      'https://www.linkedin.com/oauth/v2/authorization'
    );
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://example.up.railway.app/auth/linkedin/callback'
    );
    expect(location.searchParams.get('scope')).toBe('openid profile w_member_social');

    const state = verifyToken(location.searchParams.get('state'), STATE_SECRET, 'state');
    expect(state.slack_user_id).toBe('U777');
    expect(upserts).toHaveLength(0); // nothing stored until the callback
  });

  test('mock mode completes the handshake locally: upsert + C2 + P1', async () => {
    const { agent, upserts, slackClient } = buildApp({ config: testConfig() });
    const res = await agent.get('/auth/linkedin').query({ token: connectToken('U777') });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Success!');

    expect(upserts).toHaveLength(1);
    const { row } = upserts[0];
    expect(row.slack_user_id).toBe('U777');
    expect(row.linkedin_person_id).toBe('mock-U777');
    expect(decryptToken(row.linkedin_access_token, ENCRYPTION_KEY)).toBe('mock-token-U777');
    expect(row.expiry_reminder_sent_at).toBeNull();

    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'U777' })
    );
  });
});

describe('GET /auth/linkedin/callback', () => {
  const okLinkedin = () => ({
    exchangeCodeForToken: jest
      .fn()
      .mockResolvedValue({ accessToken: 'real-linkedin-token', expiresIn: 5184000 }),
    fetchUserInfo: jest.fn().mockResolvedValue({ sub: 'AbC123xyz' }),
  });

  test('user cancelled on LinkedIn → P2 page, nothing stored', async () => {
    const { agent, upserts } = buildApp({ config: realModeConfig(), linkedin: okLinkedin() });
    const res = await agent
      .get('/auth/linkedin/callback')
      .query({ error: 'user_cancelled_authorize', error_description: 'nope' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('nothing was connected');
    expect(upserts).toHaveLength(0);
  });

  test('non-cancel LinkedIn error → generic error page', async () => {
    const { agent } = buildApp({ config: realModeConfig(), linkedin: okLinkedin() });
    const res = await agent
      .get('/auth/linkedin/callback')
      .query({ error: 'server_error' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Something went wrong');
  });

  test('tampered/expired state → 400 P3, nothing stored', async () => {
    const linkedin = okLinkedin();
    const { agent, upserts } = buildApp({ config: realModeConfig(), linkedin });
    const res = await agent
      .get('/auth/linkedin/callback')
      .query({ code: 'code-1', state: stateToken('U777', { secret: 'wrong' }) });
    expect(res.status).toBe(400);
    expect(res.text).toContain('This link has expired');
    expect(linkedin.exchangeCodeForToken).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  test('missing code → 400', async () => {
    const { agent } = buildApp({ config: realModeConfig(), linkedin: okLinkedin() });
    const res = await agent.get('/auth/linkedin/callback').query({ state: stateToken('U777') });
    expect(res.status).toBe(400);
  });

  test('happy path: exchange, encrypt, upsert, clear reminder stamp, C2, P1', async () => {
    const linkedin = okLinkedin();
    const { agent, upserts, slackClient } = buildApp({ config: realModeConfig(), linkedin });

    const before = Date.now();
    const res = await agent
      .get('/auth/linkedin/callback')
      .query({ code: 'code-1', state: stateToken('U777') });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Success!');
    expect(linkedin.exchangeCodeForToken).toHaveBeenCalledWith(expect.anything(), 'code-1');
    expect(linkedin.fetchUserInfo).toHaveBeenCalledWith('real-linkedin-token');

    expect(upserts).toHaveLength(1);
    const { table, row } = upserts[0];
    expect(table).toBe('users');
    expect(row.slack_user_id).toBe('U777');
    expect(row.linkedin_person_id).toBe('AbC123xyz');
    expect(row.expiry_reminder_sent_at).toBeNull();
    // Token is stored encrypted (and decryptable), never in the clear.
    expect(row.linkedin_access_token).not.toContain('real-linkedin-token');
    expect(decryptToken(row.linkedin_access_token, ENCRYPTION_KEY)).toBe('real-linkedin-token');
    // ~60 days out, computed from expires_in.
    const expiresAt = row.token_expires_at.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5184000 * 1000 - 5000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5184000 * 1000 + 5000);

    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'U777' })
    );
  });

  test('LinkedIn exchange failure → 502 error page, nothing stored', async () => {
    const linkedin = {
      exchangeCodeForToken: jest.fn().mockRejectedValue(new Error('timeout')),
      fetchUserInfo: jest.fn(),
    };
    const { agent, upserts } = buildApp({ config: realModeConfig(), linkedin });
    const res = await agent
      .get('/auth/linkedin/callback')
      .query({ code: 'code-1', state: stateToken('U777') });
    expect(res.status).toBe(502);
    expect(res.text).toContain('Something went wrong');
    expect(upserts).toHaveLength(0);
  });

  test('a failed C2 DM does not fail the callback', async () => {
    const { db } = stubDb();
    const slackClient = {
      chat: { postMessage: jest.fn().mockRejectedValue(new Error('user_not_found')) },
    };
    const { receiver } = createServer(realModeConfig(), db, {
      ...testOverrides,
      slackClient,
      linkedin: okLinkedin(),
    });
    const res = await request(receiver.app)
      .get('/auth/linkedin/callback')
      .query({ code: 'code-1', state: stateToken('U777') });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Success!');
  });
});
