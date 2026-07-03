const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createServer } = require('../../src/server');
const { signToken } = require('../../src/crypto/signedToken');
const { encryptToken } = require('../../src/crypto/tokenCipher');
const { fakeAdminDb } = require('./fakeAdminDb');

const ADMIN_SESSION_SECRET = 'admin-session-secret';
const ENCRYPTION_KEY = Buffer.alloc(32, 7);

function testConfig(extra = {}) {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY.toString('base64'),
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

function buildApp({ config = testConfig(), overrideRows = [] } = {}) {
  const { db, overridesMap, auditRows } = fakeAdminDb({ overrideRows });
  const { receiver } = createServer(config, db, baseOverrides);
  return { agent: request(receiver.app), overridesMap, auditRows };
}

function sessionCookie(slackUserId = 'U111') {
  const token = signToken(
    { slack_user_id: slackUserId, purpose: 'admin_session' },
    ADMIN_SESSION_SECRET,
    12 * 60 * 60
  );
  return `admin_session=${encodeURIComponent(token)}`;
}

describe('GET /admin/api/config', () => {
  test('lists every allow-listed var with masked sensitive values', async () => {
    const { agent } = buildApp();
    const res = await agent.get('/admin/api/config').set('Cookie', sessionCookie());
    expect(res.status).toBe(200);
    const keys = res.body.vars.map((v) => v.key);
    expect(keys).toContain('REMINDER_CRON');
    expect(keys).not.toContain('DATABASE_URL');
    expect(keys).not.toContain('MARKETER_SLACK_IDS');

    const clientId = res.body.vars.find((v) => v.key === 'LINKEDIN_CLIENT_ID');
    expect(clientId.sensitive).toBe(true);
  });

  test('reflects an existing override, decrypted for a sensitive key', async () => {
    const { agent } = buildApp({
      overrideRows: [
        {
          key: 'LINKEDIN_CLIENT_SECRET',
          value: encryptToken('secret-value-1234', ENCRYPTION_KEY),
          is_sensitive: true,
          updated_by: 'U111',
          updated_at: new Date('2026-07-01'),
        },
      ],
    });
    const res = await agent.get('/admin/api/config').set('Cookie', sessionCookie());
    const entry = res.body.vars.find((v) => v.key === 'LINKEDIN_CLIENT_SECRET');
    expect(entry.source).toBe('override');
    expect(entry.value).not.toContain('secret-value-1234');
  });
});

describe('PUT /admin/api/config/:key', () => {
  test('applies a valid change and returns the reload strategy', async () => {
    const { agent, overridesMap } = buildApp();
    const res = await agent
      .put('/admin/api/config/REMINDER_CRON')
      .set('Cookie', sessionCookie())
      .send({ value: '0 10 * * *' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, reload: 'cron' });
    expect(overridesMap.get('REMINDER_CRON').value).toBe('0 10 * * *');
  });

  test('400s an invalid value', async () => {
    const { agent } = buildApp();
    const res = await agent
      .put('/admin/api/config/REMINDER_CRON')
      .set('Cookie', sessionCookie())
      .send({ value: 'garbage' });
    expect(res.status).toBe(400);
  });

  test('404s a key that is not on the allow-list', async () => {
    const { agent } = buildApp();
    const res = await agent
      .put('/admin/api/config/DATABASE_URL')
      .set('Cookie', sessionCookie())
      .send({ value: 'postgres://evil' });
    expect(res.status).toBe(404);
  });

  test('404s MARKETER_SLACK_IDS specifically (F1 regression guard)', async () => {
    const { agent } = buildApp();
    const res = await agent
      .put('/admin/api/config/MARKETER_SLACK_IDS')
      .set('Cookie', sessionCookie())
      .send({ value: 'U999' });
    expect(res.status).toBe(404);
  });

  test('404s __proto__/constructor instead of crashing or silently succeeding', async () => {
    const { agent } = buildApp();
    for (const key of ['__proto__', 'constructor']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await agent
        .put(`/admin/api/config/${key}`)
        .set('Cookie', sessionCookie())
        .send({ value: 'anything' });
      expect(res.status).toBe(404);
    }
  });

  test('rejects a non-http(s) PUBLIC_BASE_URL', async () => {
    const { agent } = buildApp();
    const res = await agent
      .put('/admin/api/config/PUBLIC_BASE_URL')
      .set('Cookie', sessionCookie())
      .send({ value: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });

  test('rejects an ADVOCACY_CHANNEL_ID that parses to zero IDs', async () => {
    const { agent } = buildApp();
    const res = await agent
      .put('/admin/api/config/ADVOCACY_CHANNEL_ID')
      .set('Cookie', sessionCookie())
      .send({ value: ',,' });
    expect(res.status).toBe(400);
  });

  test('401s without a valid admin session', async () => {
    const { agent } = buildApp();
    const res = await agent.put('/admin/api/config/REMINDER_CRON').send({ value: '0 10 * * *' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /admin/api/config/:key', () => {
  test('resets an existing override', async () => {
    const { agent, overridesMap } = buildApp({
      overrideRows: [{ key: 'REMINDER_CRON', value: '0 10 * * *', is_sensitive: false, updated_by: 'U111' }],
    });
    const res = await agent.delete('/admin/api/config/REMINDER_CRON').set('Cookie', sessionCookie());
    expect(res.status).toBe(200);
    expect(overridesMap.has('REMINDER_CRON')).toBe(false);
  });

  test('404s when there is nothing to reset', async () => {
    const { agent } = buildApp();
    const res = await agent.delete('/admin/api/config/REMINDER_CRON').set('Cookie', sessionCookie());
    expect(res.status).toBe(404);
  });

  test('404s __proto__ rather than returning a bogus success and writing a garbage audit row', async () => {
    const { agent, auditRows } = buildApp();
    const res = await agent.delete('/admin/api/config/__proto__').set('Cookie', sessionCookie());
    expect(res.status).toBe(404);
    expect(auditRows).toHaveLength(0);
  });
});

describe('GET /admin/api/audit', () => {
  test('reflects changes made through the API', async () => {
    const { agent } = buildApp();
    await agent
      .put('/admin/api/config/REMINDER_CRON')
      .set('Cookie', sessionCookie())
      .send({ value: '0 10 * * *' });

    const res = await agent.get('/admin/api/audit').set('Cookie', sessionCookie());
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ key: 'REMINDER_CRON', action: 'set', changed_by: 'U111' });
  });
});
