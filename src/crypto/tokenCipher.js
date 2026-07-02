// AES-256-GCM encryption for LinkedIn access tokens at rest — PLAN.md §5, §9.
// Stored format (base64): 12-byte IV | 16-byte auth tag | ciphertext.

const crypto = require('crypto');

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function encryptToken(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

// Throws on tampered/garbled input or a wrong key (GCM auth failure).
function decryptToken(encoded, key) {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encryptToken, decryptToken };
