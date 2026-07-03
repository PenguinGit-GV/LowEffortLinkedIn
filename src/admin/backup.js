// Backup/restore — plans/env-var-ui-feature-spec.md Phase 4.2.
//
// Only overrides are exported, not the full allow-list: Railway already
// holds the env defaults durably, so backing those up here would just be a
// stale copy of data this app doesn't own. What's uniquely at risk of loss
// is the DB-held override layer.
//
// A daily automatic snapshot (roadmap's original Phase 4.2 wording) was
// descoped in favor of this on-demand export: config_audit already retains
// every change indefinitely (Phase 1), so a separate snapshot table would
// just be a redundant materialization of data already durable. On-demand
// export covers the actual use case (a deliberate backup before a risky
// change, or migrating overrides to a fresh database).
//
// The exported JSON contains decrypted values for sensitive keys — it has
// to, to be restorable — so it is exactly as sensitive as the secrets it
// contains. Reachable only behind requireAdminSession; callers should treat
// the downloaded file accordingly.

const { getEntry } = require('./allowList');
const { loadOverrides, applyOverride } = require('./overrides');

async function exportOverrides(db, encryptionKey) {
  const overrides = await loadOverrides(db, encryptionKey);
  return Object.entries(overrides).map(([key, { raw }]) => ({ key, value: raw }));
}

// -> a diff without writing anything, so an admin can review before
// committing to a restore. Reuses each key's real validator so a
// corrupted/tampered backup file can't smuggle in an unmanaged key or an
// invalid value at restore time either.
async function planRestore(db, encryptionKey, envConfig, entries) {
  const overrides = await loadOverrides(db, encryptionKey);
  return entries.map(({ key, value }) => {
    const entry = getEntry(key);
    if (!entry) return { key, status: 'skipped', reason: 'not a manageable configuration variable' };
    if (typeof value !== 'string' || !entry.validate(value)) {
      return { key, status: 'skipped', reason: 'invalid value for this key' };
    }
    const current = overrides[key] ? overrides[key].raw : String(envConfig[entry.configKey]);
    if (current === value) return { key, status: 'unchanged' };
    return { key, status: 'would-change', from: overrides[key] ? 'override' : 'env' };
  });
}

// Applies sequentially and keeps going on a per-key failure — a bad entry in
// a large restore shouldn't roll back every other valid one.
async function applyRestore(db, encryptionKey, { entries, actorSlackId, envConfig, onApplied }) {
  const results = [];
  for (const { key, value } of entries) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await applyOverride(db, encryptionKey, {
        key,
        rawValue: value,
        actorSlackId,
        envConfig,
      });
      if (onApplied) onApplied(key, result.value);
      results.push({ key, status: 'applied' });
    } catch (err) {
      results.push({ key, status: 'error', reason: err.message });
    }
  }
  return results;
}

module.exports = { exportOverrides, planRestore, applyRestore };
