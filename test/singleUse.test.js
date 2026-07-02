const { createSingleUseGuard } = require('../src/crypto/singleUse');

describe('createSingleUseGuard', () => {
  const future = Math.floor(Date.now() / 1000) + 600;

  test('accepts a nonce once and rejects its replay', () => {
    const consume = createSingleUseGuard();
    expect(consume({ nonce: 'n1', exp: future })).toBe(true);
    expect(consume({ nonce: 'n1', exp: future })).toBe(false);
  });

  test('tracks nonces independently', () => {
    const consume = createSingleUseGuard();
    expect(consume({ nonce: 'n1', exp: future })).toBe(true);
    expect(consume({ nonce: 'n2', exp: future })).toBe(true);
  });

  test('prunes expired nonces so the set does not grow unbounded', () => {
    const consume = createSingleUseGuard();
    const past = Math.floor(Date.now() / 1000) - 1;
    // An expired entry gets pruned on the next call; the token itself would
    // already be rejected by verifyToken's expiry check, so re-acceptance
    // here is fine.
    expect(consume({ nonce: 'old', exp: past })).toBe(true);
    expect(consume({ nonce: 'fresh', exp: future })).toBe(true);
    expect(consume({ nonce: 'old', exp: past })).toBe(true);
  });
});
