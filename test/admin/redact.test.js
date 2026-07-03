// Finding F5: the audit log must never leak a real value, even for a key
// that isn't flagged sensitive but happens to hold something secret-shaped.

const { redactForAudit, looksSensitive } = require('../../src/admin/redact');

describe('redactForAudit', () => {
  test('sensitive values are always redacted with only a length hint', () => {
    expect(redactForAudit('super-secret-value', true)).toBe('«redacted, 18 chars»');
  });

  test('ordinary non-sensitive values pass through unchanged', () => {
    expect(redactForAudit('https://example.com', false)).toBe('https://example.com');
    expect(redactForAudit('0 9 * * *', false)).toBe('0 9 * * *');
  });

  test('a secret-shaped value in a non-sensitive field is redacted anyway', () => {
    // Not a real credential shape from any vendor — just enough to match the
    // "Bearer <token>" prefix the heuristic looks for.
    const bearerShaped = 'Bearer not-a-real-credential-just-shaped-like-one';
    expect(looksSensitive(bearerShaped)).toBe(true);
    expect(redactForAudit(bearerShaped, false)).toBe(
      `«redacted (value looked sensitive), ${bearerShaped.length} chars»`
    );
  });

  test('a long base64-ish blob in a non-sensitive field is redacted anyway', () => {
    const blob = 'A'.repeat(48);
    expect(looksSensitive(blob)).toBe(true);
    expect(redactForAudit(blob, false)).toBe(`«redacted (value looked sensitive), 48 chars»`);
  });

  test('null/undefined pass through as null', () => {
    expect(redactForAudit(null, true)).toBeNull();
    expect(redactForAudit(undefined, false)).toBeNull();
  });
});
