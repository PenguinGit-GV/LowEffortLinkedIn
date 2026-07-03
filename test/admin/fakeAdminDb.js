// Shared fake knex for admin config tests — same query shapes as the real
// config_overrides/config_audit tables (see src/admin/overrides.js), plus
// the db.raw() shape /healthz relies on so createServer() boots cleanly.

function fakeAdminDb({ overrideRows = [] } = {}) {
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
  db.raw = () => ({ timeout: async () => [] });
  db.fn = { now: () => new Date() };
  return { db, overridesMap, auditRows };
}

module.exports = { fakeAdminDb };
