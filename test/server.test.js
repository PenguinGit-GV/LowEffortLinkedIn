const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

function testConfig() {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
  });
}

// Static authorization so Bolt never calls the real Slack API from tests.
const testOverrides = {
  authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
};

describe('server', () => {
  test('/healthz reports ok when the database responds', async () => {
    const db = { raw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const { receiver } = createServer(testConfig(), db, testOverrides);
    const res = await request(receiver.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  test('/healthz reports degraded when the database is unreachable', async () => {
    const db = { raw: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
    const { receiver } = createServer(testConfig(), db, testOverrides);
    const res = await request(receiver.app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: 'down' });
  });

  test('/slack/events rejects unsigned requests', async () => {
    const db = { raw: jest.fn().mockResolvedValue([]) };
    const { receiver } = createServer(testConfig(), db, testOverrides);
    const res = await request(receiver.app)
      .post('/slack/events')
      .send({ type: 'event_callback' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
