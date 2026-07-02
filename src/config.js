// Environment parsing with fail-fast validation (PLAN.md §7, §9).
// The server refuses to boot on a misconfigured environment rather than
// limping into a state where e.g. nobody (or everybody) can create posts.

function loadConfig(env = process.env) {
  const missing = [];
  const req = (name) => {
    const value = env[name];
    if (!value || !value.trim()) missing.push(name);
    return value;
  };

  const slackBotToken = req('SLACK_BOT_TOKEN');
  const slackSigningSecret = req('SLACK_SIGNING_SECRET');
  const marketerIdsRaw = req('MARKETER_SLACK_IDS');
  const advocacyChannelId = req('ADVOCACY_CHANNEL_ID');
  const databaseUrl = req('DATABASE_URL');
  const oauthStateSecret = req('OAUTH_STATE_SECRET');
  const tokenEncryptionKeyB64 = req('TOKEN_ENCRYPTION_KEY');
  const publicBaseUrl = req('PUBLIC_BASE_URL');

  const linkedinMockMode = (env.LINKEDIN_MOCK_MODE || '').toLowerCase() === 'true';
  if (!linkedinMockMode) {
    req('LINKEDIN_CLIENT_ID');
    req('LINKEDIN_CLIENT_SECRET');
    req('LINKEDIN_REDIRECT_URI');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}` +
        (linkedinMockMode ? '' : ' (LINKEDIN_* are required because LINKEDIN_MOCK_MODE is not "true")')
    );
  }

  const marketerSlackIds = marketerIdsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (marketerSlackIds.length === 0) {
    throw new Error('MARKETER_SLACK_IDS must contain at least one Slack user ID');
  }

  const tokenEncryptionKey = Buffer.from(tokenEncryptionKeyB64, 'base64');
  if (tokenEncryptionKey.length !== 32) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (generate with: openssl rand -base64 32)'
    );
  }

  return {
    slackBotToken,
    slackSigningSecret,
    marketerSlackIds,
    advocacyChannelId,
    databaseUrl,
    oauthStateSecret,
    tokenEncryptionKey,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    linkedinMockMode,
    linkedinClientId: env.LINKEDIN_CLIENT_ID || null,
    linkedinClientSecret: env.LINKEDIN_CLIENT_SECRET || null,
    linkedinRedirectUri: env.LINKEDIN_REDIRECT_URI || null,
    port: Number.parseInt(env.PORT || '3000', 10),
    nodeEnv: env.NODE_ENV || 'development',
  };
}

module.exports = { loadConfig };
