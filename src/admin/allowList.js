// Server-side allow-list for admin-manageable environment variables —
// plans/env-var-ui-feature-spec.md's Variable Allow-List table.
//
// This is the ONLY place that decides which env vars the admin API will
// read or write. Anything not listed here is rejected regardless of what a
// request sends. Deliberately excluded, and not just "unlisted by oversight":
//
//   - DATABASE_URL, TOKEN_ENCRYPTION_KEY, OAUTH_STATE_SECRET,
//     SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, SLACK_CLIENT_ID/SECRET:
//     bootstrap secrets — gate reaching or decrypting the store this UI
//     itself depends on (or, for the Slack ones, gate the admin UI's own
//     login). Storing them here would be circular.
//   - PORT, NODE_ENV: can't take effect without a process restart that
//     nothing here orchestrates, and carry little value to manage live.
//   - MARKETER_SLACK_IDS: controls who can reach this UI at all. Making it
//     self-service editable is a lockout/privilege-escalation risk (spec
//     Finding F1) — a compromised or careless admin could add arbitrary
//     Slack IDs or remove every ID but their own. Railway-only, full stop.

const cron = require('node-cron');
const { MAX_POST_EXPIRY_HOURS } = require('../config');

// Reload strategy required after a value changes — see spec's "Hot-Reload
// Mechanics": a shared config object can be mutated in place for anything
// read fresh per call, but cron schedules and client-construction choices
// are captured once and need their own restart path.
const RELOAD = Object.freeze({
  MUTATE: 'mutate', // safe to apply by writing straight onto the live config object
  CRON: 'cron', // requires stopping + restarting the corresponding cron job
  RESTART: 'restart', // requires a full process restart (Phase 3 /admin/api/restart)
});

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Restricted to http(s): these values get concatenated into links shown to
// ordinary (non-admin) Slack users (e.g. PUBLIC_BASE_URL in the connect-link
// flow) and into OAuth redirect_uri params — a javascript:/file:/data: value
// would parse "successfully" as a URL but produce a broken or dangerous link.
function isValidUrl(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    const url = new URL(v);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidBool(v) {
  return v === 'true' || v === 'false';
}

function isValidCron(v) {
  return isNonEmptyString(v) && cron.validate(v);
}

// Same 1–MAX rule config.js enforces at boot and /create-post enforces
// per-submission.
function isValidPostExpiryHours(v) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 1 && n <= MAX_POST_EXPIRY_HOURS;
}

function isValidApiVersion(v) {
  return /^\d{6}$/.test(v || '');
}

function splitCommaList(v) {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// A raw string like ",," passes isNonEmptyString but parses to an empty
// array — silently violating the same "at least one ID" invariant
// config.js enforces on this var at boot.
function isValidCommaList(v) {
  return isNonEmptyString(v) && splitCommaList(v).length > 0;
}

// configKey: the property on the loaded config object this env var maps to.
// parse: raw string (as stored/submitted) -> the value's runtime shape.
// display: value -> human string for the admin list view (defaults to the
// raw stored string when omitted).
const ALLOW_LIST = Object.freeze({
  ADVOCACY_CHANNEL_ID: {
    configKey: 'advocacyChannelIds',
    sensitive: false,
    reload: RELOAD.MUTATE,
    validate: isValidCommaList,
    parse: splitCommaList,
  },
  LINKEDIN_CLIENT_ID: {
    configKey: 'linkedinClientId',
    sensitive: true,
    reload: RELOAD.MUTATE,
    validate: isNonEmptyString,
  },
  LINKEDIN_CLIENT_SECRET: {
    configKey: 'linkedinClientSecret',
    sensitive: true,
    reload: RELOAD.MUTATE,
    validate: isNonEmptyString,
  },
  LINKEDIN_REDIRECT_URI: {
    configKey: 'linkedinRedirectUri',
    sensitive: false,
    reload: RELOAD.MUTATE,
    validate: isValidUrl,
  },
  LINKEDIN_MOCK_MODE: {
    configKey: 'linkedinMockMode',
    sensitive: false,
    // The real vs. mock LinkedIn client is constructed once at boot
    // (createShareClient(config) in server.js); flipping this needs a
    // restart, not a config mutation, however tempting it looks.
    reload: RELOAD.RESTART,
    validate: isValidBool,
    parse: (v) => v === 'true',
    // config.js only requires the LINKEDIN_* vars at boot when the ENV says
    // mock mode is off — an override merges in after that validation ran, so
    // flipping to real mode here must carry the same cross-field check
    // itself. Without it the next restart boots in real mode with
    // client_id=null: every connect link redirects to a broken LinkedIn
    // authorize URL and every real share 401s, with no boot error.
    crossValidate: (effective) =>
      effective.linkedinMockMode === false &&
      !(effective.linkedinClientId && effective.linkedinClientSecret && effective.linkedinRedirectUri)
        ? 'LINKEDIN_MOCK_MODE can only be "false" once LINKEDIN_CLIENT_ID, ' +
          'LINKEDIN_CLIENT_SECRET and LINKEDIN_REDIRECT_URI are configured'
        : null,
  },
  LINKEDIN_API_VERSION: {
    configKey: 'linkedinVersion',
    sensitive: false,
    reload: RELOAD.MUTATE,
    validate: isValidApiVersion,
  },
  REMINDER_CRON: {
    configKey: 'reminderCron',
    sensitive: false,
    reload: RELOAD.CRON,
    validate: isValidCron,
  },
  POST_EXPIRY_CRON: {
    configKey: 'postExpiryCron',
    sensitive: false,
    reload: RELOAD.CRON,
    validate: isValidCron,
  },
  DEFAULT_POST_EXPIRY_HOURS: {
    configKey: 'defaultPostExpiryHours',
    sensitive: false,
    reload: RELOAD.MUTATE,
    validate: isValidPostExpiryHours,
    parse: (v) => Number.parseFloat(v),
  },
  PUBLIC_BASE_URL: {
    configKey: 'publicBaseUrl',
    sensitive: false,
    reload: RELOAD.MUTATE,
    validate: isValidUrl,
    parse: (v) => v.replace(/\/+$/, ''),
  },
});

function isManaged(key) {
  return Object.prototype.hasOwnProperty.call(ALLOW_LIST, key);
}

// A plain bracket lookup (ALLOW_LIST[key]) would return an inherited
// Object.prototype member — truthy, not undefined — for key values like
// "__proto__" or "constructor", silently defeating every "!entry" guard
// callers rely on to reject an unmanaged key. hasOwnProperty first closes
// that off.
function getEntry(key) {
  return isManaged(key) ? ALLOW_LIST[key] : undefined;
}

module.exports = { ALLOW_LIST, RELOAD, isManaged, getEntry };
