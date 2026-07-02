const { loadConfig } = require('../src/config');

// 32 bytes, base64
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

function validEnv(overrides = {}) {
  return {
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111,U222',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: VALID_KEY,
    PUBLIC_BASE_URL: 'https://example.up.railway.app/',
    LINKEDIN_MOCK_MODE: 'true',
    ...overrides,
  };
}

describe('loadConfig', () => {
  test('parses a valid environment', () => {
    const config = loadConfig(validEnv());
    expect(config.marketerSlackIds).toEqual(['U111', 'U222']);
    expect(config.tokenEncryptionKey.length).toBe(32);
    expect(config.linkedinMockMode).toBe(true);
    expect(config.publicBaseUrl).toBe('https://example.up.railway.app'); // trailing slash stripped
    expect(config.port).toBe(3000);
  });

  test('fails fast when a required variable is missing', () => {
    expect(() => loadConfig(validEnv({ SLACK_BOT_TOKEN: '' }))).toThrow(/SLACK_BOT_TOKEN/);
  });

  test('fails fast when MARKETER_SLACK_IDS is only whitespace/commas', () => {
    expect(() => loadConfig(validEnv({ MARKETER_SLACK_IDS: ' , ,' }))).toThrow(
      /MARKETER_SLACK_IDS/
    );
  });

  test('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig(validEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }))
    ).toThrow(/32 bytes/);
  });

  test('requires LinkedIn credentials only when mock mode is off', () => {
    expect(() => loadConfig(validEnv({ LINKEDIN_MOCK_MODE: 'false' }))).toThrow(
      /LINKEDIN_CLIENT_ID/
    );
    const config = loadConfig(
      validEnv({
        LINKEDIN_MOCK_MODE: 'false',
        LINKEDIN_CLIENT_ID: 'cid',
        LINKEDIN_CLIENT_SECRET: 'csecret',
        LINKEDIN_REDIRECT_URI: 'https://example.up.railway.app/auth/linkedin/callback',
      })
    );
    expect(config.linkedinMockMode).toBe(false);
    expect(config.linkedinClientId).toBe('cid');
  });
});
