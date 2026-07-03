// Admin config API — plans/env-var-ui-feature-spec.md. Every route here sits
// behind requireAdminSession; mutating routes additionally require a JSON
// body (see auth.js's requireJsonContentType for why).

const express = require('express');
const { requireAdminSession, requireJsonContentType } = require('./auth');
const {
  listManagedVars,
  applyOverride,
  resetOverride,
  listAudit,
  ConfigOverrideError,
} = require('./overrides');
const { createLockRegistry } = require('./locks');
const { exportOverrides, planRestore, applyRestore } = require('./backup');

function statusForError(err) {
  if (!(err instanceof ConfigOverrideError)) return 500;
  return err.code === 'NOT_MANAGED' ? 404 : 400;
}

// envConfig is the pure Railway-set defaults, independent of any override —
// distinct from `config`, which Phase 3's reload controller mutates in place
// for RELOAD.MUTATE/CRON keys. Defaults to `config` itself so callers that
// never wire hot-reload (most tests) still work: nothing mutates it then, so
// the two stay identical.
function registerAdminApi(router, { config, db, envConfig = config, reloadController, logger = console }) {
  const auth = requireAdminSession(config);
  const applyReload = reloadController ? reloadController.applyReload : () => {};
  // One registry per running server, matching crypto/singleUse.js's
  // in-memory-because-single-process rationale (Phase 4.3 edit locking).
  const lockRegistry = createLockRegistry();
  // Small, bounded body — these are single config values, not file uploads.
  const jsonBody = express.json({ limit: '16kb' });
  // Backups can legitimately hold every allow-listed key's value.
  const restoreBody = express.json({ limit: '64kb' });

  router.get('/admin/api/config', auth, async (_req, res) => {
    try {
      const vars = await listManagedVars(envConfig, db, config.tokenEncryptionKey);
      res.json({ vars });
    } catch (err) {
      logger.error('GET /admin/api/config failed:', err);
      res.status(500).json({ error: 'failed to load configuration' });
    }
  });

  // Best-effort reservation before an admin starts typing — see locks.js.
  // Not required before a write (below), which re-checks ownership itself;
  // this just lets the UI show "locked by X" before anyone has typed
  // anything.
  router.post('/admin/api/config/:key/lock', auth, (req, res) => {
    const result = lockRegistry.acquire(req.params.key, req.adminSlackUserId);
    if (!result.ok) {
      res.status(409).json({ error: `${req.params.key} is locked for editing by another admin`, ...result });
      return;
    }
    res.json(result);
  });

  router.delete('/admin/api/config/:key/lock', auth, (req, res) => {
    lockRegistry.release(req.params.key, req.adminSlackUserId);
    res.json({ ok: true });
  });

  router.put('/admin/api/config/:key', auth, jsonBody, requireJsonContentType, async (req, res) => {
    const { key } = req.params;
    const rawValue = req.body && req.body.value;
    if (typeof rawValue !== 'string') {
      res.status(400).json({ error: '"value" must be a string' });
      return;
    }
    const lockCheck = lockRegistry.check(key, req.adminSlackUserId);
    if (!lockCheck.ok) {
      res.status(409).json({ error: `${key} is locked for editing by another admin`, ...lockCheck });
      return;
    }
    try {
      const result = await applyOverride(db, config.tokenEncryptionKey, {
        key,
        rawValue,
        actorSlackId: req.adminSlackUserId,
        envConfig,
      });
      applyReload(key, result.value);
      lockRegistry.release(key, req.adminSlackUserId);
      res.json({ ok: true, reload: result.reload });
    } catch (err) {
      if (err instanceof ConfigOverrideError) {
        res.status(statusForError(err)).json({ error: err.message });
        return;
      }
      logger.error(`PUT /admin/api/config/${key} failed:`, err);
      res.status(500).json({ error: 'failed to apply configuration change' });
    }
  });

  router.delete('/admin/api/config/:key', auth, async (req, res) => {
    const { key } = req.params;
    const lockCheck = lockRegistry.check(key, req.adminSlackUserId);
    if (!lockCheck.ok) {
      res.status(409).json({ error: `${key} is locked for editing by another admin`, ...lockCheck });
      return;
    }
    try {
      const result = await resetOverride(db, config.tokenEncryptionKey, {
        key,
        actorSlackId: req.adminSlackUserId,
        envConfig,
      });
      if (!result) {
        res.status(404).json({ error: `"${key}" has no override to reset` });
        return;
      }
      applyReload(key, result.value);
      lockRegistry.release(key, req.adminSlackUserId);
      res.json({ ok: true, reload: result.reload });
    } catch (err) {
      if (err instanceof ConfigOverrideError) {
        res.status(statusForError(err)).json({ error: err.message });
        return;
      }
      logger.error(`DELETE /admin/api/config/${key} failed:`, err);
      res.status(500).json({ error: 'failed to reset configuration value' });
    }
  });

  router.get('/admin/api/audit', auth, async (req, res) => {
    try {
      const page = Number.parseInt(req.query.page, 10) || 1;
      const entries = await listAudit(db, { key: req.query.key, page, perPage: 20 });
      res.json({ entries, page });
    } catch (err) {
      logger.error('GET /admin/api/audit failed:', err);
      res.status(500).json({ error: 'failed to load audit log' });
    }
  });

  // Sensitive by nature (plaintext values of whatever's currently
  // overridden) — behind the same requireAdminSession as everything else,
  // no additional endpoint-specific gate.
  router.get('/admin/api/backup', auth, async (_req, res) => {
    try {
      const entries = await exportOverrides(db, config.tokenEncryptionKey);
      res.json({ exportedAt: new Date().toISOString(), entries });
    } catch (err) {
      logger.error('GET /admin/api/backup failed:', err);
      res.status(500).json({ error: 'failed to export configuration' });
    }
  });

  // { entries: [{key, value}], dryRun: boolean }. dryRun (the default)
  // returns a diff without writing anything, so the UI can show what would
  // change before an admin commits to it.
  router.post('/admin/api/restore', auth, restoreBody, requireJsonContentType, async (req, res) => {
    const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : null;
    if (!entries || entries.some((e) => typeof e.key !== 'string' || typeof e.value !== 'string')) {
      res.status(400).json({ error: '"entries" must be an array of { key, value } strings' });
      return;
    }
    try {
      if (req.body.dryRun !== false) {
        const plan = await planRestore(db, config.tokenEncryptionKey, envConfig, entries);
        res.json({ dryRun: true, plan });
        return;
      }
      const results = await applyRestore(db, config.tokenEncryptionKey, {
        entries,
        actorSlackId: req.adminSlackUserId,
        envConfig,
        onApplied: applyReload,
      });
      res.json({ dryRun: false, results });
    } catch (err) {
      logger.error('POST /admin/api/restore failed:', err);
      res.status(500).json({ error: 'failed to process restore' });
    }
  });
}

module.exports = { registerAdminApi };
