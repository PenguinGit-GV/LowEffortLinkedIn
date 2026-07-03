// Edit locking — plans/env-var-ui-feature-spec.md Phase 4.3, scoped down
// from "real-time push" (no websocket infra exists in this app) to
// poll-on-conflict: an admin claims a short-lived lock before editing a key,
// and a second admin trying the same key gets a 409 with who holds it.
//
// In-memory on purpose, same rationale as crypto/singleUse.js: this is a
// single Node process (PLAN.md §3), so a restart dropping all locks is
// harmless — worst case, a lock an admin was mid-edit on needs re-claiming.

const LOCK_TTL_MS = 2 * 60 * 1000; // long enough to type a value, short enough that an abandoned tab self-heals quickly

function createLockRegistry(ttlMs = LOCK_TTL_MS) {
  const locks = new Map(); // key -> { slackUserId, expiresAt }

  function prune(now) {
    for (const [key, lock] of locks) {
      if (lock.expiresAt <= now) locks.delete(key);
    }
  }

  function conflictOrNull(key, slackUserId, now) {
    prune(now);
    const existing = locks.get(key);
    if (existing && existing.slackUserId !== slackUserId) {
      return { lockedBy: existing.slackUserId, expiresAt: existing.expiresAt };
    }
    return null;
  }

  // Re-acquiring your own lock refreshes its TTL — a slow typist shouldn't
  // lose the lock mid-edit.
  function acquire(key, slackUserId, now = Date.now()) {
    const conflict = conflictOrNull(key, slackUserId, now);
    if (conflict) return { ok: false, ...conflict };
    const expiresAt = now + ttlMs;
    locks.set(key, { slackUserId, expiresAt });
    return { ok: true, expiresAt };
  }

  function release(key, slackUserId) {
    const existing = locks.get(key);
    if (existing && existing.slackUserId === slackUserId) locks.delete(key);
  }

  // Non-mutating check used at write time (PUT/DELETE) — a write from the
  // lock holder (or an unlocked key) proceeds; a write attempting to jump a
  // lock held by someone else is rejected the same way acquire() would be.
  function check(key, slackUserId, now = Date.now()) {
    const conflict = conflictOrNull(key, slackUserId, now);
    return conflict ? { ok: false, ...conflict } : { ok: true };
  }

  return { acquire, release, check };
}

module.exports = { createLockRegistry, LOCK_TTL_MS };
