// Persistence + read-model for admin config overrides.
//
// Deliberately a PURE data layer: nothing here touches the live running
// process's shared config object or reschedules cron jobs. `mergeEffectiveConfig`
// returns a brand-new merged object for read purposes (the admin list view);
// actually applying a change to the running app (in-place mutation for safe
// vars, stop/restart for cron vars, a full restart for LINKEDIN_MOCK_MODE) is
// Phase 3's job (plans/env-var-ui-feature-spec.md), built on top of this.

const { ALLOW_LIST, getEntry } = require('./allowList');
const { encryptToken, decryptToken } = require('../crypto/tokenCipher');
const { redactForAudit } = require('./redact');

class ConfigOverrideError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// -> { raw, updatedAt, updatedBy }, or null when the row can't be used: its
// key is no longer in the allow-list (e.g. removed in a later deploy), or it
// no longer decrypts (a rotated TOKEN_ENCRYPTION_KEY or a corrupted value).
// A stale row is skipped rather than thrown on — it shouldn't 500 an
// unrelated admin action, and loadOverrides runs unconditionally at boot
// (index.js), where throwing wouldn't 500 one request — it would crash-loop
// the whole process, taking down the very admin UI that could fix the bad
// row.
function decodeOverrideRow(row, encryptionKey, logger) {
  const entry = getEntry(row.key);
  if (!entry) return null;
  let raw;
  if (row.is_sensitive) {
    try {
      raw = decryptToken(row.value, encryptionKey);
    } catch {
      logger.error(
        `Config override for ${row.key} could not be decrypted (rotated ` +
          'TOKEN_ENCRYPTION_KEY or corrupted row?) — ignoring it; the env ' +
          'default applies until the value is re-entered in the admin UI'
      );
      return null;
    }
  } else {
    raw = row.value;
  }
  return { raw, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

// Decrypts every stored row's raw string value, keyed by env var name.
async function loadOverrides(db, encryptionKey, { logger = console } = {}) {
  const rows = await db('config_overrides').select();
  const out = {};
  for (const row of rows) {
    const decoded = decodeOverrideRow(row, encryptionKey, logger);
    if (decoded) out[row.key] = decoded;
  }
  return out;
}

// Single-key variant for the write paths: loading (and decrypting) every
// override just to read one key's prior value would also re-log the
// "could not be decrypted" error for an unrelated corrupted row on every
// write.
async function loadOverride(db, encryptionKey, key, { logger = console } = {}) {
  const row = await db('config_overrides').where({ key }).first();
  return row ? decodeOverrideRow(row, encryptionKey, logger) : null;
}

// envConfig (loadConfig(process.env)) + DB overrides -> a new config-shaped
// object. Pure — does not mutate envConfig.
function mergeEffectiveConfig(envConfig, overrides) {
  const merged = { ...envConfig };
  for (const [key, { raw }] of Object.entries(overrides)) {
    const entry = getEntry(key);
    if (!entry) continue;
    merged[entry.configKey] = entry.parse ? entry.parse(raw) : raw;
  }
  return merged;
}

// Masking only applies to an actual value — masking the "(not set)"
// placeholder itself would just show a confusing "••••set)" with nothing
// real to hide.
function maskForDisplay(value, isSensitive) {
  if (value === null || value === undefined) return '(not set)';
  if (!isSensitive) return String(value);
  const str = String(value);
  return str.length <= 4 ? '••••' : `••••${str.slice(-4)}`;
}

// A few LinkedIn vars are null in mock mode (never set in the environment) —
// String(null) would otherwise render the literal text "null" in the audit
// trail.
function displayOf(value) {
  return value === null || value === undefined ? '(not set)' : String(value);
}

// -> [{ key, value, sensitive, reload, source, updatedAt, updatedBy }]
// value is masked for sensitive keys — the raw value never leaves this module
// for those.
async function listManagedVars(envConfig, db, encryptionKey) {
  const overrides = await loadOverrides(db, encryptionKey);
  return Object.entries(ALLOW_LIST).map(([key, entry]) => {
    const override = overrides[key];
    const runtimeValue = override
      ? entry.parse
        ? entry.parse(override.raw)
        : override.raw
      : envConfig[entry.configKey];
    return {
      key,
      value: maskForDisplay(runtimeValue, entry.sensitive),
      sensitive: entry.sensitive,
      reload: entry.reload,
      source: override ? 'override' : 'env',
      updatedAt: override ? override.updatedAt : null,
      updatedBy: override ? override.updatedBy : null,
    };
  });
}

async function applyOverride(db, encryptionKey, { key, rawValue, actorSlackId, envConfig }) {
  const entry = getEntry(key);
  if (!entry) {
    throw new ConfigOverrideError(`"${key}" is not a manageable configuration variable`, 'NOT_MANAGED');
  }
  if (typeof rawValue !== 'string' || !entry.validate(rawValue)) {
    throw new ConfigOverrideError(`"${rawValue}" is not a valid value for ${key}`, 'INVALID_VALUE');
  }

  const existing = await loadOverride(db, encryptionKey, key);
  // Per-key validate() can't see the rest of the config; entries whose
  // validity depends on other keys (LINKEDIN_MOCK_MODE needs the LinkedIn
  // credentials) veto based on the effective config this write would
  // produce at the next boot — the one write-path case that needs the full
  // override set.
  if (entry.crossValidate) {
    const overrides = await loadOverrides(db, encryptionKey);
    const effective = mergeEffectiveConfig(envConfig, { ...overrides, [key]: { raw: rawValue } });
    const crossError = entry.crossValidate(effective);
    if (crossError) throw new ConfigOverrideError(crossError, 'INVALID_VALUE');
  }
  const priorRaw = existing ? existing.raw : displayOf(envConfig[entry.configKey]);
  const oldDisplay = redactForAudit(priorRaw, entry.sensitive);
  const newDisplay = redactForAudit(rawValue, entry.sensitive);
  const storedValue = entry.sensitive ? encryptToken(rawValue, encryptionKey) : rawValue;

  await db.transaction(async (trx) => {
    await trx('config_overrides')
      .insert({
        key,
        value: storedValue,
        is_sensitive: entry.sensitive,
        updated_by: actorSlackId,
        updated_at: trx.fn.now(),
      })
      .onConflict('key')
      .merge({
        value: storedValue,
        is_sensitive: entry.sensitive,
        updated_by: actorSlackId,
        updated_at: trx.fn.now(),
      });
    await trx('config_audit').insert({
      key,
      action: 'set',
      old_value_display: oldDisplay,
      new_value_display: newDisplay,
      changed_by: actorSlackId,
    });
  });

  // configKey/value let Phase 3's reload controller apply this to the live
  // process without re-deriving the parsed runtime value itself.
  return { reload: entry.reload, configKey: entry.configKey, value: entry.parse ? entry.parse(rawValue) : rawValue };
}

// -> null if there was no override to reset (caller should 404).
async function resetOverride(db, encryptionKey, { key, actorSlackId, envConfig }) {
  const entry = getEntry(key);
  if (!entry) {
    throw new ConfigOverrideError(`"${key}" is not a manageable configuration variable`, 'NOT_MANAGED');
  }

  const existing = await loadOverride(db, encryptionKey, key);
  if (!existing) return null;

  const oldDisplay = redactForAudit(existing.raw, entry.sensitive);
  const newDisplay = redactForAudit(displayOf(envConfig[entry.configKey]), entry.sensitive);

  await db.transaction(async (trx) => {
    await trx('config_overrides').where({ key }).delete();
    await trx('config_audit').insert({
      key,
      action: 'reset',
      old_value_display: oldDisplay,
      new_value_display: newDisplay,
      changed_by: actorSlackId,
    });
  });

  return { reload: entry.reload, configKey: entry.configKey, value: envConfig[entry.configKey] };
}

async function listAudit(db, { key, page = 1, perPage = 20 } = {}) {
  let query = db('config_audit').orderBy('changed_at', 'desc');
  if (key) query = query.where({ key });
  const offset = (Math.max(1, page) - 1) * perPage;
  return query.limit(perPage).offset(offset);
}

module.exports = {
  ConfigOverrideError,
  loadOverrides,
  mergeEffectiveConfig,
  listManagedVars,
  applyOverride,
  resetOverride,
  listAudit,
  maskForDisplay,
};
