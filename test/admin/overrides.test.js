const { loadConfig } = require('../../src/config');
const { encryptToken } = require('../../src/crypto/tokenCipher');
const {
  listManagedVars,
  applyOverride,
  resetOverride,
  listAudit,
  ConfigOverrideError,
} = require('../../src/admin/overrides');

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

// Mirrors the fakeDb shape used in test/postExpiry.test.js and
// test/expiryReminder.test.js: a minimal knex stand-in covering exactly the
// query shapes overrides.js issues. db.transaction just runs the callback
// against the same fake — no real atomicity needed for these tests.
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
      insert: (row) => ({
        onConflict: () => ({
          merge: async () => overridesMap.set(row.key, { ...row }),
        }),
      }),
    };
  }

  function auditTable() {
    return {
      insert: async (row) => {
        auditRows.unshift({ id: `audit-${auditRows.length}`, changed_at: new Date(), ...row });
      },
      orderBy: () => ({
        where: (cond) => ({
          limit: (n) => ({
            offset: async (o) => auditRows.filter((r) => r.key === cond.key).slice(o, o + n),
          }),
        }),
        limit: (n) => ({
          offset: async (o) => auditRows.slice(o, o + n),
        }),
      }),
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

describe('listManagedVars', () => {
  test('shows env defaults with source "env" when nothing is overridden', async () => {
    const { db } = fakeDb();
    const vars = await listManagedVars(envConfig(), db, KEY);
    const publicBaseUrl = vars.find((v) => v.key === 'PUBLIC_BASE_URL');
    expect(publicBaseUrl).toMatchObject({ source: 'env', sensitive: false });
    expect(publicBaseUrl.value).toBe('https://example.up.railway.app');
  });

  test('masks sensitive values regardless of source', async () => {
    const { db } = fakeDb({
      overrideRows: [
        {
          key: 'LINKEDIN_CLIENT_ID',
          value: encryptToken('super-secret-client-id', KEY),
          is_sensitive: true,
          updated_by: 'U111',
          updated_at: new Date('2026-07-01'),
        },
      ],
    });
    const vars = await listManagedVars(envConfig(), db, KEY);
    const entry = vars.find((v) => v.key === 'LINKEDIN_CLIENT_ID');
    expect(entry.source).toBe('override');
    expect(entry.value).toBe('••••t-id');
    expect(entry.value).not.toContain('super-secret');
  });

  test('a stored override for a key removed from the allow-list is ignored, not thrown on', async () => {
    const { db } = fakeDb({
      overrideRows: [{ key: 'REMOVED_KEY', value: 'x', is_sensitive: false, updated_by: 'U111' }],
    });
    await expect(listManagedVars(envConfig(), db, KEY)).resolves.toBeInstanceOf(Array);
  });

  test('shows "(not set)" rather than the literal string "null" for an unset env default', async () => {
    const { db } = fakeDb();
    // LINKEDIN_REDIRECT_URI is null in mock mode — never configured.
    const vars = await listManagedVars(envConfig(), db, KEY);
    const redirectUri = vars.find((v) => v.key === 'LINKEDIN_REDIRECT_URI');
    expect(redirectUri.value).toBe('(not set)');
  });
});

describe('applyOverride', () => {
  test('rejects a key that is not on the allow-list', async () => {
    const { db } = fakeDb();
    const promise = applyOverride(db, KEY, {
      key: 'DATABASE_URL',
      rawValue: 'x',
      actorSlackId: 'U111',
      envConfig: envConfig(),
    });
    await expect(promise).rejects.toBeInstanceOf(ConfigOverrideError);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_MANAGED' });
  });

  test('rejects an invalid value for a managed key', async () => {
    const { db } = fakeDb();
    await expect(
      applyOverride(db, KEY, {
        key: 'REMINDER_CRON',
        rawValue: 'not-a-cron',
        actorSlackId: 'U111',
        envConfig: envConfig(),
      })
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
  });

  test('stores a non-sensitive value in plaintext and logs the real value in the audit trail', async () => {
    const { db, overridesMap, auditRows } = fakeDb();
    const result = await applyOverride(db, KEY, {
      key: 'REMINDER_CRON',
      rawValue: '30 8 * * *',
      actorSlackId: 'U111',
      envConfig: envConfig(),
    });
    expect(result.reload).toBe('cron');
    expect(overridesMap.get('REMINDER_CRON').value).toBe('30 8 * * *');
    expect(auditRows[0]).toMatchObject({
      key: 'REMINDER_CRON',
      action: 'set',
      new_value_display: '30 8 * * *',
      changed_by: 'U111',
    });
  });

  test('encrypts a sensitive value at rest and redacts it in the audit trail', async () => {
    const { db, overridesMap, auditRows } = fakeDb();
    await applyOverride(db, KEY, {
      key: 'LINKEDIN_CLIENT_SECRET',
      rawValue: 'real-secret-value',
      actorSlackId: 'U222',
      envConfig: envConfig(),
    });
    const stored = overridesMap.get('LINKEDIN_CLIENT_SECRET');
    expect(stored.value).not.toContain('real-secret-value');
    expect(stored.is_sensitive).toBe(true);
    expect(auditRows[0].new_value_display).not.toContain('real-secret-value');
    expect(auditRows[0].new_value_display).toContain('redacted');
  });

  test('a secret-shaped value in a non-sensitive field is still redacted in the audit trail (F5)', async () => {
    const { db, auditRows } = fakeDb();
    // Not a real credential from any vendor — a long base64-ish blob, which
    // is enough to trip the length-based heuristic in src/admin/redact.js.
    const tokenShaped = 'A'.repeat(48);
    await applyOverride(db, KEY, {
      key: 'ADVOCACY_CHANNEL_ID',
      rawValue: tokenShaped,
      actorSlackId: 'U111',
      envConfig: envConfig(),
    });
    expect(auditRows[0].new_value_display).not.toContain(tokenShaped);
    expect(auditRows[0].new_value_display).toContain('redacted');
  });

  test('overwriting an existing override records the prior value as old_value_display', async () => {
    const { db, auditRows } = fakeDb({
      overrideRows: [
        { key: 'REMINDER_CRON', value: '0 9 * * *', is_sensitive: false, updated_by: 'U111' },
      ],
    });
    await applyOverride(db, KEY, {
      key: 'REMINDER_CRON',
      rawValue: '0 10 * * *',
      actorSlackId: 'U222',
      envConfig: envConfig(),
    });
    expect(auditRows[0]).toMatchObject({
      old_value_display: '0 9 * * *',
      new_value_display: '0 10 * * *',
    });
  });
});

describe('resetOverride', () => {
  test('returns null when there is nothing to reset', async () => {
    const { db } = fakeDb();
    const result = await resetOverride(db, KEY, {
      key: 'REMINDER_CRON',
      actorSlackId: 'U111',
      envConfig: envConfig(),
    });
    expect(result).toBeNull();
  });

  test('deletes the override and records a reset audit entry back to the env default', async () => {
    const { db, overridesMap, auditRows } = fakeDb({
      overrideRows: [
        { key: 'REMINDER_CRON', value: '0 10 * * *', is_sensitive: false, updated_by: 'U111' },
      ],
    });
    const result = await resetOverride(db, KEY, {
      key: 'REMINDER_CRON',
      actorSlackId: 'U222',
      envConfig: envConfig(),
    });
    expect(result.reload).toBe('cron');
    expect(overridesMap.has('REMINDER_CRON')).toBe(false);
    expect(auditRows[0]).toMatchObject({
      action: 'reset',
      old_value_display: '0 10 * * *',
      new_value_display: '0 9 * * *', // config.js's REMINDER_CRON default
    });
  });
});

describe('listAudit', () => {
  test('filters by key and paginates newest-first', async () => {
    const { db } = fakeDb();
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await applyOverride(db, KEY, {
        key: 'REMINDER_CRON',
        rawValue: `${i} 9 * * *`,
        actorSlackId: 'U111',
        envConfig: envConfig(),
      });
    }
    await applyOverride(db, KEY, {
      key: 'POST_EXPIRY_CRON',
      rawValue: '*/5 * * * *',
      actorSlackId: 'U111',
      envConfig: envConfig(),
    });

    const all = await listAudit(db, { page: 1, perPage: 10 });
    expect(all).toHaveLength(4);

    const filtered = await listAudit(db, { key: 'REMINDER_CRON', page: 1, perPage: 10 });
    expect(filtered).toHaveLength(3);
    expect(filtered[0].new_value_display).toBe('2 9 * * *'); // most recent first
  });
});
