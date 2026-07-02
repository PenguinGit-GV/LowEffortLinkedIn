const crypto = require('crypto');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

const SIGNING_SECRET = 'shhh';

function testConfig() {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
  });
}

// Static authorization so Bolt never calls the real Slack API from tests;
// error-level logging keeps expected rejections out of the test output.
const testOverrides = {
  authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
  logLevel: 'error',
};

// The healthz probe calls db.raw('select 1').timeout(...), so the stub returns
// a knex-builder-shaped object whose timeout() resolves or rejects.
function stubDb({ up }) {
  return {
    raw: jest.fn(() => ({
      timeout: up
        ? jest.fn().mockResolvedValue([{ '?column?': 1 }])
        : jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    })),
  };
}

function slackSignature(rawBody, timestamp) {
  const hmac = crypto.createHmac('sha256', SIGNING_SECRET);
  hmac.update(`v0:${timestamp}:${rawBody}`);
  return `v0=${hmac.digest('hex')}`;
}

describe('server', () => {
  test('/healthz reports ok when the database responds', async () => {
    const { receiver } = createServer(testConfig(), stubDb({ up: true }), testOverrides);
    const res = await request(receiver.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  test('/healthz reports degraded when the database is unreachable', async () => {
    const { receiver } = createServer(testConfig(), stubDb({ up: false }), testOverrides);
    const res = await request(receiver.app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: 'down' });
  });

  test('/slack/events rejects unsigned requests', async () => {
    const { receiver } = createServer(testConfig(), stubDb({ up: true }), testOverrides);
    const res = await request(receiver.app)
      .post('/slack/events')
      .send({ type: 'event_callback' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('/slack/events accepts a correctly signed request', async () => {
    const { receiver } = createServer(testConfig(), stubDb({ up: true }), testOverrides);
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'chal-123' });
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await request(receiver.app)
      .post('/slack/events')
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', String(timestamp))
      .set('x-slack-signature', slackSignature(rawBody, timestamp))
      .send(rawBody);
    expect(res.status).toBe(200);
    expect(res.text).toContain('chal-123');
  });
});
