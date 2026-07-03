const { loadConfig } = require('../../src/config');
const { encryptToken } = require('../../src/crypto/tokenCipher');
const { exportOverrides, planRestore, applyRestore } = require('../../src/admin/backup');

const KEY = Buffer.alloc(32, 7);

function envConfig(extra = {}) {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: KEY.toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
    ...extra,
  });
}

// Same fake shape as test/admin/overrides.test.js.
function fakeDb({ overrideRows = [] } = {}) {
  const overridesMap = new Map(overrideRows.map((r) => [r.key, { ...r }]));
  const auditRows = [];

  function overridesTable() {
    return {
      select: async () => Array.from(overridesMap.values()),
      where: (cond) => ({
        first: async () => overridesMap.get(cond.key),
        delete: async () => (overridesMap.delete(cond.key) ? 1 : 0),
      }),
      insert: (row) => ({ onConflict: () => ({ merge: async () => overridesMap.set(row.key, { ...row }) }) }),
    };
  }
  function auditTable() {
    return {
      insert: async (row) => auditRows.push(row),
      orderBy: () => ({ limit: () => ({ offset: async () => auditRows }) }),
    };
  }
  const db = (table) => {
    if (table === 'config_overrides') return overridesTable();
    if (table === 'config_audit') return auditTable();
    throw new Error(`unexpected table ${table}`);
  };
  db.transaction = async (cb) => cb(db);
  db.fn = { now: () => 'NOW' };
  return { db, overridesMap, auditRows };
}

describe('exportOverrides', () => {
  test('exports only keys with an active override, decrypted', async () => {
    const { db } = fakeDb({
      overrideRows: [
        { key: 'REMINDER_CRON', value: '0 10 * * *', is_sensitive: false, updated_by: 'U111' },
        {
          key: 'LINKEDIN_CLIENT_SECRET',
          value: encryptToken('real-secret', KEY),
          is_sensitive: true,
          updated_by: 'U111',
        },
      ],
    });
    const entries = await exportOverrides(db, KEY);
    expect(entries).toEqual(
      expect.arrayContaining([
        { key: 'REMINDER_CRON', value: '0 10 * * *' },
        { key: 'LINKEDIN_CLIENT_SECRET', value: 'real-secret' },
      ])
    );
    // Nothing for keys that are just the env default.
    expect(entries.find((e) => e.key === 'PUBLIC_BASE_URL')).toBeUndefined();
  });

  test('an empty override set exports an empty list, not an error', async () => {
    const { db } = fakeDb();
    await expect(exportOverrides(db, KEY)).resolves.toEqual([]);
  });
});

describe('planRestore', () => {
  test('flags an unmanaged key as skipped without touching the database', async () => {
    const { db } = fakeDb();
    const plan = await planRestore(db, KEY, envConfig(), [{ key: 'DATABASE_URL', value: 'x' }]);
    expect(plan).toEqual([
      { key: 'DATABASE_URL', status: 'skipped', reason: 'not a manageable configuration variable' },
    ]);
  });

  test('flags an invalid value as skipped', async () => {
    const { db } = fakeDb();
    const plan = await planRestore(db, KEY, envConfig(), [{ key: 'REMINDER_CRON', value: 'not-a-cron' }]);
    expect(plan).toEqual([{ key: 'REMINDER_CRON', status: 'skipped', reason: 'invalid value for this key' }]);
  });

  test('flags an identical value as unchanged', async () => {
    const { db } = fakeDb();
    // envConfig()'s REMINDER_CRON default is '0 9 * * *'.
    const plan = await planRestore(db, KEY, envConfig(), [{ key: 'REMINDER_CRON', value: '0 9 * * *' }]);
    expect(plan).toEqual([{ key: 'REMINDER_CRON', status: 'unchanged' }]);
  });

  test('flags a genuine change as would-change, noting the current source', async () => {
    const { db } = fakeDb();
    const plan = await planRestore(db, KEY, envConfig(), [{ key: 'REMINDER_CRON', value: '0 12 * * *' }]);
    expect(plan).toEqual([
      {
        key: 'REMINDER_CRON',
        status: 'would-change',
        from: 'env',
        currentDisplay: '0 9 * * *',
        newDisplay: '0 12 * * *',
      },
    ]);
  });

  test('masks a would-change diff for a sensitive key rather than showing the raw value', async () => {
    const { db } = fakeDb();
    const plan = await planRestore(db, KEY, envConfig(), [
      { key: 'LINKEDIN_CLIENT_SECRET', value: 'brand-new-secret-value' },
    ]);
    expect(plan[0].status).toBe('would-change');
    expect(plan[0].currentDisplay).not.toContain('brand-new-secret-value');
    expect(plan[0].newDisplay).not.toContain('brand-new-secret-value');
    expect(plan[0].newDisplay).toMatch(/^••••/);
  });
});

describe('applyRestore', () => {
  test('applies valid entries and reports errors per-key without aborting the rest', async () => {
    const { db, overridesMap } = fakeDb();
    const onApplied = jest.fn();
    const results = await applyRestore(db, KEY, {
      entries: [
        { key: 'REMINDER_CRON', value: '0 12 * * *' },
        { key: 'REMINDER_CRON', value: 'not-a-cron' }, // fails after the first succeeds
        { key: 'DATABASE_URL', value: 'x' }, // not manageable
      ],
      actorSlackId: 'U111',
      envConfig: envConfig(),
      onApplied,
    });

    expect(results[0]).toEqual({ key: 'REMINDER_CRON', status: 'applied' });
    expect(results[1]).toMatchObject({ key: 'REMINDER_CRON', status: 'error' });
    expect(results[2]).toMatchObject({ key: 'DATABASE_URL', status: 'error' });
    expect(overridesMap.get('REMINDER_CRON').value).toBe('0 12 * * *');
    expect(onApplied).toHaveBeenCalledWith('REMINDER_CRON', '0 12 * * *');
    expect(onApplied).toHaveBeenCalledTimes(1); // only the successful one
  });

  test('rejects a key someone else holds an active edit-lock on, without aborting the rest', async () => {
    const { db, overridesMap } = fakeDb();
    const checkLock = jest.fn((key) =>
      key === 'REMINDER_CRON' ? { ok: false, lockedBy: 'U999' } : { ok: true }
    );

    const results = await applyRestore(db, KEY, {
      entries: [
        { key: 'REMINDER_CRON', value: '0 20 * * *' },
        { key: 'PUBLIC_BASE_URL', value: 'https://restored.up.railway.app' },
      ],
      actorSlackId: 'U111',
      envConfig: envConfig(),
      checkLock,
    });

    expect(results[0]).toEqual({ key: 'REMINDER_CRON', status: 'error', reason: 'locked for editing by U999' });
    expect(results[1]).toEqual({ key: 'PUBLIC_BASE_URL', status: 'applied' });
    expect(overridesMap.has('REMINDER_CRON')).toBe(false);
    expect(overridesMap.get('PUBLIC_BASE_URL').value).toBe('https://restored.up.railway.app');
  });
});
