// Environment parsing with fail-fast validation (PLAN.md §7, §9).
// The server refuses to boot on a misconfigured environment rather than
// limping into a state where e.g. nobody (or everybody) can create posts.

// Shared with handlers/createPost.js so the modal's per-post override can't
// drift from the bound this config enforces.
const MAX_POST_EXPIRY_HOURS = 720; // 30 days

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

  // Admin config UI (plans/env-var-ui-feature-spec.md) is opt-in: these are
  // new bootstrap secrets (they gate the admin UI itself, same class of
  // problem as SLACK_SIGNING_SECRET) that most deployments won't have set up
  // yet. Gating on a flag, mirroring the LINKEDIN_MOCK_MODE pattern above,
  // keeps every existing deployment and test config working unchanged.
  const adminUiEnabled = (env.ADMIN_UI_ENABLED || '').toLowerCase() === 'true';
  if (adminUiEnabled) {
    req('SLACK_CLIENT_ID');
    req('SLACK_CLIENT_SECRET');
    req('ADMIN_SESSION_SECRET');
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

  const advocacyChannelIds = advocacyChannelId
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (advocacyChannelIds.length === 0) {
    throw new Error('ADVOCACY_CHANNEL_ID must contain at least one channel ID');
  }

  const tokenEncryptionKey = Buffer.from(tokenEncryptionKeyB64, 'base64');
  if (tokenEncryptionKey.length !== 32) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (generate with: openssl rand -base64 32)'
    );
  }

  const port = Number.parseInt(env.PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${env.PORT}"`);
  }

  // Default sharing window for a new post; the marketer can override this
  // per-post in /create-post, bounded by the same MAX_POST_EXPIRY_HOURS.
  const defaultPostExpiryHours = Number.parseFloat(env.DEFAULT_POST_EXPIRY_HOURS || '8');
  if (
    !Number.isFinite(defaultPostExpiryHours) ||
    defaultPostExpiryHours <= 0 ||
    defaultPostExpiryHours > MAX_POST_EXPIRY_HOURS
  ) {
    throw new Error(
      `DEFAULT_POST_EXPIRY_HOURS must be a number between 0 and ${MAX_POST_EXPIRY_HOURS}, ` +
        `got "${env.DEFAULT_POST_EXPIRY_HOURS}"`
    );
  }

  return {
    slackBotToken,
    slackSigningSecret,
    marketerSlackIds,
    advocacyChannelIds,
    databaseUrl,
    oauthStateSecret,
    tokenEncryptionKey,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    linkedinMockMode,
    linkedinClientId: env.LINKEDIN_CLIENT_ID || null,
    linkedinClientSecret: env.LINKEDIN_CLIENT_SECRET || null,
    linkedinRedirectUri: env.LINKEDIN_REDIRECT_URI || null,
    // Versioned-API header (YYYYMM); override when LinkedIn sunsets the default.
    linkedinVersion: env.LINKEDIN_API_VERSION || '202506',
    // Daily token-expiry reminder schedule (UTC); validated at job start.
    reminderCron: env.REMINDER_CRON || '0 9 * * *',
    defaultPostExpiryHours,
    // Post-expiry windows are hours-scale, so this runs far more often than
    // the daily token reminder; validated at job start.
    postExpiryCron: env.POST_EXPIRY_CRON || '*/15 * * * *',
    port,
    nodeEnv: env.NODE_ENV || 'development',
    adminUiEnabled,
    slackClientId: env.SLACK_CLIENT_ID || null,
    slackClientSecret: env.SLACK_CLIENT_SECRET || null,
    adminSessionSecret: env.ADMIN_SESSION_SECRET || null,
  };
}

module.exports = { loadConfig, MAX_POST_EXPIRY_HOURS };
