// Audit-log redaction — spec Finding F5. Trusting each key's static
// `sensitive` flag alone isn't enough: a secret pasted into a nominally
// "safe" field (e.g. PUBLIC_BASE_URL) would otherwise land in config_audit
// in plaintext forever. This applies a shape-based heuristic on top of the
// allow-list's classification as defense in depth — imperfect by nature,
// but it costs nothing and catches the obvious cases.

// Common secret-token prefixes/shapes seen in the wild (Slack, GitHub,
// GitLab, generic bearer tokens, base64-looking blobs of suspicious length).
const SECRET_SHAPED = /^(xox[baprs]-|sk-|ghp_|gho_|glpat-|Bearer\s)/i;
const LOOKS_LIKE_LONG_TOKEN = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;

function looksSensitive(value) {
  const str = String(value);
  return SECRET_SHAPED.test(str) || LOOKS_LIKE_LONG_TOKEN.test(str);
}

// -> a short, safe-to-store display string. Never returns the raw value for
// anything sensitive (by flag or by shape).
function redactForAudit(value, isSensitive) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (isSensitive) return `«redacted, ${str.length} chars»`;
  if (looksSensitive(str)) return `«redacted (value looked sensitive), ${str.length} chars»`;
  return str;
}

module.exports = { redactForAudit, looksSensitive };
