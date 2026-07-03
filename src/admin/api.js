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
  // Small, bounded body — these are single config values, not file uploads.
  const jsonBody = express.json({ limit: '16kb' });

  router.get('/admin/api/config', auth, async (_req, res) => {
    try {
      const vars = await listManagedVars(envConfig, db, config.tokenEncryptionKey);
      res.json({ vars });
    } catch (err) {
      logger.error('GET /admin/api/config failed:', err);
      res.status(500).json({ error: 'failed to load configuration' });
    }
  });

  router.put('/admin/api/config/:key', auth, jsonBody, requireJsonContentType, async (req, res) => {
    const { key } = req.params;
    const rawValue = req.body && req.body.value;
    if (typeof rawValue !== 'string') {
      res.status(400).json({ error: '"value" must be a string' });
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
}

module.exports = { registerAdminApi };
