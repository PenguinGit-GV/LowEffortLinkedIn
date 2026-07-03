// Proves the wiring, not just the isolated unit: a PUT through the real
// server actually reaches the live config object and the real cron job
// starters — reload.test.js covers the logic in isolation with mocked job
// starters; this covers server.js/index.js's threading of envConfig/jobs/
// reloadController end to end.

const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createServer } = require('../../src/server');
const { startExpiryReminderJob } = require('../../src/jobs/expiryReminder');
const { signToken } = require('../../src/crypto/signedToken');
const { fakeAdminDb } = require('./fakeAdminDb');

const ADMIN_SESSION_SECRET = 'admin-session-secret';

function testConfig(extra = {}) {
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
    ADMIN_UI_ENABLED: 'true',
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    ADMIN_SESSION_SECRET,
    ...extra,
  });
}

function sessionCookie() {
  const token = signToken(
    { slack_user_id: 'U111', purpose: 'admin_session' },
    ADMIN_SESSION_SECRET,
    12 * 60 * 60
  );
  return `admin_session=${encodeURIComponent(token)}`;
}

const baseOverrides = {
  authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
  logLevel: 'error',
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
};

describe('hot reload wiring through the real server', () => {
  test('a MUTATE-kind PUT is visible on the same live config object passed to createServer', async () => {
    const config = testConfig();
    const { db } = fakeAdminDb();
    const { receiver } = createServer(config, db, baseOverrides);

    await request(receiver.app)
      .put('/admin/api/config/PUBLIC_BASE_URL')
      .set('Cookie', sessionCookie())
      .send({ value: 'https://hot-reloaded.up.railway.app' })
      .expect(200);

    expect(config.publicBaseUrl).toBe('https://hot-reloaded.up.railway.app');
  });

  test('a CRON-kind PUT stops the old job and replaces it with a freshly scheduled one', async () => {
    const config = testConfig();
    const { db } = fakeAdminDb();
    const jobs = { reminderJob: startExpiryReminderJob({ config, db }) };
    const stopSpy = jest.spyOn(jobs.reminderJob, 'stop');
    const originalTask = jobs.reminderJob;

    const { receiver } = createServer(config, db, { ...baseOverrides, jobs });

    await request(receiver.app)
      .put('/admin/api/config/REMINDER_CRON')
      .set('Cookie', sessionCookie())
      .send({ value: '0 12 * * *' })
      .expect(200);

    expect(config.reminderCron).toBe('0 12 * * *');
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(jobs.reminderJob).not.toBe(originalTask);

    jobs.reminderJob.stop(); // avoid a dangling cron task past the test
  });

  test('resetting an override restores the true env default, not a value mutated by a MUTATE-kind reload', async () => {
    // envConfig is a separate pristine object from `config` — this is the
    // regression case index.js's split exists to prevent.
    const envConfig = testConfig();
    const config = { ...envConfig };
    const { db } = fakeAdminDb();
    const { receiver } = createServer(config, db, { ...baseOverrides, envConfig });

    await request(receiver.app)
      .put('/admin/api/config/PUBLIC_BASE_URL')
      .set('Cookie', sessionCookie())
      .send({ value: 'https://temporary.up.railway.app' })
      .expect(200);
    expect(config.publicBaseUrl).toBe('https://temporary.up.railway.app');

    await request(receiver.app)
      .delete('/admin/api/config/PUBLIC_BASE_URL')
      .set('Cookie', sessionCookie())
      .expect(200);

    expect(config.publicBaseUrl).toBe('https://example.up.railway.app');
  });
});
