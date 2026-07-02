const { signToken, verifyToken } = require('../src/crypto/signedToken');

const SECRET = 'test-secret';

describe('signedToken', () => {
  test('round-trips a payload with matching purpose', () => {
    const token = signToken({ slack_user_id: 'U123', purpose: 'connect' }, SECRET, 60);
    const payload = verifyToken(token, SECRET, 'connect');
    expect(payload).not.toBeNull();
    expect(payload.slack_user_id).toBe('U123');
    expect(payload.nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  test('two tokens for the same payload differ (random nonce)', () => {
    const a = signToken({ slack_user_id: 'U123', purpose: 'connect' }, SECRET, 60);
    const b = signToken({ slack_user_id: 'U123', purpose: 'connect' }, SECRET, 60);
    expect(a).not.toBe(b);
  });

  test('rejects a tampered payload', () => {
    const token = signToken({ slack_user_id: 'U123', purpose: 'connect' }, SECRET, 60);
    const [data, mac] = token.split('.');
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    payload.slack_user_id = 'U_ATTACKER';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
    expect(verifyToken(forged, SECRET, 'connect')).toBeNull();
  });

  test('rejects a token signed with a different secret', () => {
    const token = signToken({ slack_user_id: 'U123', purpose: 'connect' }, 'other-secret', 60);
    expect(verifyToken(token, SECRET, 'connect')).toBeNull();
  });

  test('rejects an expired token', () => {
    const token = signToken({ slack_user_id: 'U123', purpose: 'connect' }, SECRET, -1);
    expect(verifyToken(token, SECRET, 'connect')).toBeNull();
  });

  test('rejects a purpose mismatch (state token used as connect link)', () => {
    const token = signToken({ slack_user_id: 'U123', purpose: 'state' }, SECRET, 60);
    expect(verifyToken(token, SECRET, 'connect')).toBeNull();
  });

  test('rejects malformed input', () => {
    expect(verifyToken(undefined, SECRET, 'connect')).toBeNull();
    expect(verifyToken('', SECRET, 'connect')).toBeNull();
    expect(verifyToken('no-dot-here', SECRET, 'connect')).toBeNull();
    expect(verifyToken('a.b.c', SECRET, 'connect')).toBeNull();
    expect(verifyToken('!!!.???', SECRET, 'connect')).toBeNull();
  });
});
