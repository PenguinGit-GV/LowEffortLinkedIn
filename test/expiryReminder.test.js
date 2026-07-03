const { loadConfig } = require('../src/config');
const { verifyToken } = require('../src/crypto/signedToken');
const {
  runExpiryReminder,
  startExpiryReminderJob,
  buildReminderBlocks,
  REMINDER_LINK_TTL_SECONDS,
} = require('../src/jobs/expiryReminder');

const STATE_SECRET = 'state-secret';

function testConfig(extra = {}) {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: STATE_SECRET,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
    ...extra,
  });
}

const NOW = new Date('2026-07-02T09:00:00Z');

function dueUser(slackUserId, expiresAt) {
  return {
    slack_user_id: slackUserId,
    linkedin_access_token: 'enc',
    token_expires_at: expiresAt,
    expiry_reminder_sent_at: null,
  };
}

// The query-shape itself is exercised against real Postgres in the smoke run;
// unit tests stub the due-list and verify the send/stamp behavior around it.
function fakeDb(dueUsers) {
  const updates = [];
  const db = (table) => {
    if (table !== 'users') throw new Error(`unexpected table ${table}`);
    const b = {
      whereNotNull: () => b,
      where: () => b,
      whereNull: () => b,
      orWhereRaw: () => b,
      update: async (patch) => {
        updates.push(patch);
        return 1;
      },
      then: (resolve, reject) => Promise.resolve(dueUsers).then(resolve, reject),
    };
    return b;
  };
  db.fn = { now: () => 'NOW' };
  return { db, updates };
}

// Mirrors @slack/logger's real Logger interface (no .log) — see
// test/share.test.js's quietLogger for why this matters: a mock with an
// extra .log stub masked the exact bug that broke production once already.
const quiet = { error: jest.fn(), info: jest.fn() };

describe('runExpiryReminder', () => {
  test('DMs each due user with C5 and a long-lived reconnect link, then stamps', async () => {
    const expires = new Date(NOW.getTime() + 5 * 24 * 3600 * 1000);
    const { db, updates } = fakeDb([dueUser('U777', expires)]);
    const slackClient = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } };

    const result = await runExpiryReminder(
      { db, config: testConfig(), slackClient, logger: quiet },
      NOW
    );

    expect(result).toEqual({ due: 1, sent: 1 });
    const msg = slackClient.chat.postMessage.mock.calls[0][0];
    expect(msg.channel).toBe('U777');
    expect(msg.text).toContain('expires in 5 days');

    const button = msg.blocks.find((b) => b.type === 'actions').elements[0];
    const url = new URL(button.url);
    const payload = verifyToken(url.searchParams.get('token'), STATE_SECRET, 'connect');
    expect(payload.slack_user_id).toBe('U777');
    // Link lives as long as the reminder window, not the 15-min C1 default.
    expect(payload.exp - payload.iat).toBe(REMINDER_LINK_TTL_SECONDS);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({ expiry_reminder_sent_at: 'NOW' })
    );
  });

  test('singularizes at 1 day and never says 0 days', async () => {
    const expires = new Date(NOW.getTime() + 3 * 3600 * 1000); // 3 hours out
    const { db } = fakeDb([dueUser('U777', expires)]);
    const slackClient = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } };
    await runExpiryReminder({ db, config: testConfig(), slackClient, logger: quiet }, NOW);
    expect(slackClient.chat.postMessage.mock.calls[0][0].text).toContain('expires in 1 day.');
  });

  test('a failed DM leaves the stamp unwritten and continues with other users', async () => {
    const expires = new Date(NOW.getTime() + 2 * 24 * 3600 * 1000);
    const { db, updates } = fakeDb([dueUser('U_FAIL', expires), dueUser('U_OK', expires)]);
    const slackClient = {
      chat: {
        postMessage: jest
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('boom'), { data: { error: 'user_not_found' } }))
          .mockResolvedValueOnce({ ok: true }),
      },
    };

    const result = await runExpiryReminder(
      { db, config: testConfig(), slackClient, logger: quiet },
      NOW
    );

    expect(result).toEqual({ due: 2, sent: 1 });
    expect(slackClient.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(1); // only U_OK stamped; U_FAIL retries tomorrow
  });

  test('does nothing when nobody is due', async () => {
    const { db, updates } = fakeDb([]);
    const slackClient = { chat: { postMessage: jest.fn() } };
    const result = await runExpiryReminder(
      { db, config: testConfig(), slackClient, logger: quiet },
      NOW
    );
    expect(result).toEqual({ due: 0, sent: 0 });
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('startExpiryReminderJob', () => {
  test('schedules the configured cron in UTC and returns the task', () => {
    const task = { stop: jest.fn() };
    const cronLib = { validate: jest.fn().mockReturnValue(true), schedule: jest.fn(() => task) };
    const returned = startExpiryReminderJob(
      { config: testConfig(), db: {}, logger: quiet },
      { cronLib, slackClient: { chat: {} } }
    );
    expect(returned).toBe(task);
    expect(cronLib.schedule).toHaveBeenCalledWith(
      '0 9 * * *',
      expect.any(Function),
      { timezone: 'Etc/UTC' }
    );
  });

  test('honors REMINDER_CRON and fails fast on an invalid expression', () => {
    const cronLib = { validate: (expr) => expr === '30 7 * * *', schedule: jest.fn(() => ({})) };
    startExpiryReminderJob(
      { config: testConfig({ REMINDER_CRON: '30 7 * * *' }), db: {}, logger: quiet },
      { cronLib, slackClient: { chat: {} } }
    );
    expect(cronLib.schedule).toHaveBeenCalledWith('30 7 * * *', expect.any(Function), {
      timezone: 'Etc/UTC',
    });

    expect(() =>
      startExpiryReminderJob(
        { config: testConfig({ REMINDER_CRON: 'not-a-cron' }), db: {}, logger: quiet },
        { cronLib, slackClient: { chat: {} } }
      )
    ).toThrow(/REMINDER_CRON/);
  });

  test('the real node-cron accepts the default expression', () => {
    const cron = require('node-cron');
    expect(cron.validate(testConfig().reminderCron)).toBe(true);
  });
});

describe('buildReminderBlocks', () => {
  test('C5 text and a url button with the connect action id', () => {
    const blocks = buildReminderBlocks(testConfig(), { slack_user_id: 'U9' }, 3);
    expect(blocks[0].text.text).toContain('3 days');
    const button = blocks[1].elements[0];
    expect(button.action_id).toBe('connect_linkedin');
    expect(button.url).toContain('/auth/linkedin?token=');
  });
});
