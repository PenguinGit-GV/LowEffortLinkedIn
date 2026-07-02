const { encryptToken, decryptToken } = require('../src/crypto/tokenCipher');

const KEY = Buffer.alloc(32, 7);

describe('tokenCipher', () => {
  test('round-trips a token', () => {
    const encrypted = encryptToken('AQXdSP…linkedin-token', KEY);
    expect(decryptToken(encrypted, KEY)).toBe('AQXdSP…linkedin-token');
  });

  test('ciphertext is not the plaintext and differs per call (random IV)', () => {
    const a = encryptToken('secret-token', KEY);
    const b = encryptToken('secret-token', KEY);
    expect(a).not.toContain('secret-token');
    expect(a).not.toBe(b);
  });

  test('throws on a tampered ciphertext', () => {
    const encrypted = encryptToken('secret-token', KEY);
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptToken(buf.toString('base64'), KEY)).toThrow();
  });

  test('throws with the wrong key', () => {
    const encrypted = encryptToken('secret-token', KEY);
    expect(() => decryptToken(encrypted, Buffer.alloc(32, 9))).toThrow();
  });
});
