// HMAC-SHA256 signed, short-lived tokens — PLAN.md §2.2 steps 2–3.
// Used for both the connect-link token (?token= on /auth/linkedin) and the
// OAuth state param. Each token carries a `purpose` so the two kinds are not
// interchangeable, a random nonce, and an expiry.

const crypto = require('crypto');

function signToken(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    nonce: crypto.randomBytes(8).toString('hex'),
    iat: now,
    exp: now + ttlSeconds,
  };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

// Returns the payload, or null for anything invalid: malformed, bad signature,
// wrong purpose, or expired. Callers only need "valid or not".
function verifyToken(token, secret, expectedPurpose) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, mac] = parts;

  const expectedMac = crypto.createHmac('sha256', secret).update(data).digest();
  const givenMac = Buffer.from(mac, 'base64url');
  if (givenMac.length !== expectedMac.length || !crypto.timingSafeEqual(givenMac, expectedMac)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.purpose !== expectedPurpose) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = { signToken, verifyToken };
