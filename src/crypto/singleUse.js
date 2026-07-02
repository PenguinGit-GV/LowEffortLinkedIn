// Single-use guard for signed tokens: remembers consumed nonces until their
// expiry so a captured OAuth state can't be replayed within its TTL.
// In-memory on purpose — the app is a single process (PLAN.md §3) and states
// live ≤10 minutes, so a restart forgetting the set is harmless (the signature
// + expiry checks still hold; only replay-of-a-used-state protection resets).

function createSingleUseGuard() {
  const seen = new Map(); // nonce -> exp (unix seconds)

  // True the first time a payload's nonce is presented, false on replay.
  return function consume(payload) {
    const now = Math.floor(Date.now() / 1000);
    for (const [nonce, exp] of seen) {
      if (exp <= now) seen.delete(nonce);
    }
    if (seen.has(payload.nonce)) return false;
    seen.set(payload.nonce, payload.exp);
    return true;
  };
}

module.exports = { createSingleUseGuard };
