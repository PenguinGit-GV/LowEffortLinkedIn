// The allow-list is the enforcement point for spec Finding F1 and the
// bootstrap-secret exclusions — these tests double as a regression guard so
// a future edit can't silently re-add a var that shouldn't be self-service.

const { ALLOW_LIST, RELOAD, isManaged, getEntry } = require('../../src/admin/allowList');

describe('allow-list exclusions', () => {
  const excluded = [
    'DATABASE_URL',
    'TOKEN_ENCRYPTION_KEY',
    'OAUTH_STATE_SECRET',
    'SLACK_SIGNING_SECRET',
    'SLACK_BOT_TOKEN',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'ADMIN_SESSION_SECRET',
    'PORT',
    'NODE_ENV',
    // Finding F1: self-service editing of who can reach this UI is a
    // lockout / privilege-escalation risk.
    'MARKETER_SLACK_IDS',
  ];

  test.each(excluded)('%s is never manageable', (key) => {
    expect(isManaged(key)).toBe(false);
    expect(getEntry(key)).toBeUndefined();
  });

  // A plain ALLOW_LIST[key] bracket lookup returns an inherited
  // Object.prototype member (truthy) for these keys instead of undefined,
  // which would silently defeat every "!entry" guard in overrides.js —
  // e.g. PUT/DELETE /admin/api/config/__proto__ bypassing the "not
  // manageable" rejection entirely.
  test.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    '%s (an Object.prototype member) is not manageable',
    (key) => {
      expect(isManaged(key)).toBe(false);
      expect(getEntry(key)).toBeUndefined();
    }
  );
});

describe('allow-list validators', () => {
  test('REMINDER_CRON / POST_EXPIRY_CRON accept valid cron and reject garbage', () => {
    expect(ALLOW_LIST.REMINDER_CRON.validate('0 9 * * *')).toBe(true);
    expect(ALLOW_LIST.REMINDER_CRON.validate('not-a-cron')).toBe(false);
    expect(ALLOW_LIST.POST_EXPIRY_CRON.reload).toBe(RELOAD.CRON);
  });

  test('LINKEDIN_MOCK_MODE only accepts the literal strings true/false', () => {
    expect(ALLOW_LIST.LINKEDIN_MOCK_MODE.validate('true')).toBe(true);
    expect(ALLOW_LIST.LINKEDIN_MOCK_MODE.validate('false')).toBe(true);
    expect(ALLOW_LIST.LINKEDIN_MOCK_MODE.validate('yes')).toBe(false);
    expect(ALLOW_LIST.LINKEDIN_MOCK_MODE.reload).toBe(RELOAD.RESTART);
  });

  test('DEFAULT_POST_EXPIRY_HOURS enforces the same bounds as config.js', () => {
    expect(ALLOW_LIST.DEFAULT_POST_EXPIRY_HOURS.validate('8')).toBe(true);
    expect(ALLOW_LIST.DEFAULT_POST_EXPIRY_HOURS.validate('0')).toBe(false);
    expect(ALLOW_LIST.DEFAULT_POST_EXPIRY_HOURS.validate('99999')).toBe(false);
    expect(ALLOW_LIST.DEFAULT_POST_EXPIRY_HOURS.validate('nope')).toBe(false);
  });

  test('PUBLIC_BASE_URL and LINKEDIN_REDIRECT_URI require a parseable URL', () => {
    expect(ALLOW_LIST.PUBLIC_BASE_URL.validate('https://example.com')).toBe(true);
    expect(ALLOW_LIST.PUBLIC_BASE_URL.validate('not a url')).toBe(false);
  });

  test('PUBLIC_BASE_URL and LINKEDIN_REDIRECT_URI reject non-http(s) schemes', () => {
    // These values get concatenated into links shown to ordinary Slack
    // users and into OAuth redirect_uri params — new URL() alone would
    // accept javascript:/file:/data: as "syntactically valid".
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(ALLOW_LIST.PUBLIC_BASE_URL.validate(bad)).toBe(false);
      expect(ALLOW_LIST.LINKEDIN_REDIRECT_URI.validate(bad)).toBe(false);
    }
  });

  test('ADVOCACY_CHANNEL_ID rejects a comma list that parses to zero IDs', () => {
    // ",," passes a naive non-empty-string check but parses (via the comma
    // split/trim/filter) to an empty array — silently violating config.js's
    // own boot-time "at least one channel ID" invariant.
    expect(ALLOW_LIST.ADVOCACY_CHANNEL_ID.validate(',,')).toBe(false);
    expect(ALLOW_LIST.ADVOCACY_CHANNEL_ID.validate(' , , ')).toBe(false);
    expect(ALLOW_LIST.ADVOCACY_CHANNEL_ID.validate('C0123ABCDEF')).toBe(true);
  });

  test('LINKEDIN_API_VERSION requires a 6-digit YYYYMM', () => {
    expect(ALLOW_LIST.LINKEDIN_API_VERSION.validate('202506')).toBe(true);
    expect(ALLOW_LIST.LINKEDIN_API_VERSION.validate('2025')).toBe(false);
  });

  test('sensitive keys are flagged for masking', () => {
    expect(ALLOW_LIST.LINKEDIN_CLIENT_ID.sensitive).toBe(true);
    expect(ALLOW_LIST.LINKEDIN_CLIENT_SECRET.sensitive).toBe(true);
    expect(ALLOW_LIST.PUBLIC_BASE_URL.sensitive).toBe(false);
  });
});
