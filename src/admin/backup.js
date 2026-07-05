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
const { loadOverrides, applyOverride, maskForDisplay } = require('./overrides');

async function exportOverrides(db, encryptionKey) {
  const overrides = await loadOverrides(db, encryptionKey);
  return Object.entries(overrides).map(([key, { raw }]) => ({ key, value: raw }));
}

// -> a diff without writing anything, so an admin can review before
// committing to a restore. Reuses each key's real validator so a
// corrupted/tampered backup file can't smuggle in an unmanaged key or an
// invalid value at restore time either.
//
// currentDisplay/newDisplay are masked the same way the config list view
// masks sensitive values — a diff that showed raw values would put a
// secret like LINKEDIN_CLIENT_SECRET on screen in plaintext, undermining
// the masking discipline used everywhere else in the dashboard.
async function planRestore(db, encryptionKey, envConfig, entries) {
  const overrides = await loadOverrides(db, encryptionKey);
  return entries.map(({ key, value }) => {
    const entry = getEntry(key);
    if (!entry) return { key, status: 'skipped', reason: 'not a manageable configuration variable' };
    if (typeof value !== 'string' || !entry.validate(value)) {
      return { key, status: 'skipped', reason: 'invalid value for this key' };
    }
    // Compare parsed runtime shapes, not strings: an env-sourced value only
    // exists in parsed form (an array, a number), and re-serializing it with
    // String() made equivalent inputs look changed — e.g. ADVOCACY_CHANNEL_ID
    // env "C1, C2" stringifies to "C1,C2", so a backup holding the same list
    // with spaces was reported as would-change and, applied, created a
    // redundant override of an unchanged value.
    const currentRuntime = overrides[key]
      ? entry.parse
        ? entry.parse(overrides[key].raw)
        : overrides[key].raw
      : envConfig[entry.configKey];
    const newRuntime = entry.parse ? entry.parse(value) : value;
    if (JSON.stringify(newRuntime) === JSON.stringify(currentRuntime)) {
      return { key, status: 'unchanged' };
    }
    return {
      key,
      status: 'would-change',
      from: overrides[key] ? 'override' : 'env',
      currentDisplay: maskForDisplay(currentRuntime, entry.sensitive),
      newDisplay: maskForDisplay(value, entry.sensitive),
    };
  });
}

// Applies sequentially and keeps going on a per-key failure — a bad entry in
// a large restore shouldn't roll back every other valid one. checkLock lets
// the caller reject a key someone else is mid-edit on, the same way a
// direct PUT/DELETE would be rejected — without it, a restore could
// silently clobber a value another admin is actively editing (confirmed:
// see plans/env-var-ui-feature-spec.md's Phase 4 review).
async function applyRestore(db, encryptionKey, { entries, actorSlackId, envConfig, onApplied, checkLock }) {
  // Apply cross-validated keys (LINKEDIN_MOCK_MODE) after everything else:
  // a backup's entry order follows DB row order, which isn't guaranteed, and
  // applying mock=false before the credential entries it depends on would
  // reject a perfectly valid backup when restoring into a fresh database.
  // The sort is stable, so the relative order of everything else is kept.
  const ordered = [...entries].sort(
    (a, b) => (getEntry(a.key)?.crossValidate ? 1 : 0) - (getEntry(b.key)?.crossValidate ? 1 : 0)
  );
  const results = [];
  for (const { key, value } of ordered) {
    if (checkLock) {
      const lockCheck = checkLock(key, actorSlackId);
      if (!lockCheck.ok) {
        results.push({ key, status: 'error', reason: `locked for editing by ${lockCheck.lockedBy}` });
        // eslint-disable-next-line no-continue
        continue;
      }
    }
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
