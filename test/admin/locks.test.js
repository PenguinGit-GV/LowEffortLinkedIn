const { createLockRegistry } = require('../../src/admin/locks');

describe('createLockRegistry', () => {
  test('acquiring an unlocked key succeeds', () => {
    const registry = createLockRegistry();
    const result = registry.acquire('REMINDER_CRON', 'U111');
    expect(result.ok).toBe(true);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  test('a second admin acquiring the same key gets a 409-shaped conflict', () => {
    const registry = createLockRegistry();
    registry.acquire('REMINDER_CRON', 'U111');
    const result = registry.acquire('REMINDER_CRON', 'U222');
    expect(result.ok).toBe(false);
    expect(result.lockedBy).toBe('U111');
  });

  test('the same admin re-acquiring their own lock refreshes it rather than conflicting', () => {
    const registry = createLockRegistry();
    registry.acquire('REMINDER_CRON', 'U111', 1000);
    const result = registry.acquire('REMINDER_CRON', 'U111', 2000);
    expect(result.ok).toBe(true);
  });

  test('release frees the lock for someone else to acquire', () => {
    const registry = createLockRegistry();
    registry.acquire('REMINDER_CRON', 'U111');
    registry.release('REMINDER_CRON', 'U111');
    const result = registry.acquire('REMINDER_CRON', 'U222');
    expect(result.ok).toBe(true);
  });

  test("release by a non-owner is a no-op — can't steal-release someone else's lock", () => {
    const registry = createLockRegistry();
    registry.acquire('REMINDER_CRON', 'U111');
    registry.release('REMINDER_CRON', 'U222');
    const result = registry.acquire('REMINDER_CRON', 'U222');
    expect(result.ok).toBe(false); // still held by U111
  });

  test('an expired lock is treated as free', () => {
    const registry = createLockRegistry(1000); // 1s TTL
    registry.acquire('REMINDER_CRON', 'U111', 0);
    const result = registry.acquire('REMINDER_CRON', 'U222', 5000); // well past expiry
    expect(result.ok).toBe(true);
  });

  test('check() mirrors acquire() without side effects', () => {
    const registry = createLockRegistry();
    registry.acquire('REMINDER_CRON', 'U111');
    expect(registry.check('REMINDER_CRON', 'U222').ok).toBe(false);
    expect(registry.check('REMINDER_CRON', 'U111').ok).toBe(true); // owner's own writes proceed
    // Calling check() repeatedly didn't itself grant U222 the lock.
    expect(registry.check('REMINDER_CRON', 'U222').ok).toBe(false);
  });
});
