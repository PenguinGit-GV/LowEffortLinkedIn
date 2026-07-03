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

function isValidUrl(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(v);
    return true;
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

function isValidPostExpiryHours(v) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 && n <= MAX_POST_EXPIRY_HOURS;
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

// configKey: the property on the loaded config object this env var maps to.
// parse: raw string (as stored/submitted) -> the value's runtime shape.
// display: value -> human string for the admin list view (defaults to the
// raw stored string when omitted).
const ALLOW_LIST = Object.freeze({
  ADVOCACY_CHANNEL_ID: {
    configKey: 'advocacyChannelIds',
    sensitive: false,
    reload: RELOAD.MUTATE,
    validate: isNonEmptyString,
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

function getEntry(key) {
  return ALLOW_LIST[key];
}

module.exports = { ALLOW_LIST, RELOAD, isManaged, getEntry };
