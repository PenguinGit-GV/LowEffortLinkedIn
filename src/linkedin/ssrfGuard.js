// Blocks the article-title fetch (src/linkedin/pageTitle.js) from reaching
// private/internal network addresses. The URL is marketer-supplied, not
// arbitrary public input, but a marketer account is still a lower trust tier
// than the server itself — this is the standard SSRF shape (an authorized
// user's legitimate feature making server-side requests to attacker-chosen
// URLs), and the server sits on a network that can reach real internal
// infrastructure (Postgres via *.railway.internal, potentially cloud
// metadata endpoints).
//
// Implemented as a custom DNS `lookup` (Node's http/https core — and
// follow-redirects, which just creates further http/https requests — call
// this to resolve every hostname before connecting, including each redirect
// hop) rather than a one-time check of the initial URL. Checking only the
// initial URL would miss both a malicious redirect to an internal address
// and DNS rebinding (a second lookup returning a different address than an
// earlier check saw); validating the address `lookup` itself resolves closes
// both gaps.

const dns = require('dns');
const net = require('net');

const DISALLOWED_HOSTNAME_SUFFIXES = ['.railway.internal', '.internal', 'localhost'];

// IPv4 ranges covering loopback, RFC1918 private space, link-local (which
// includes the 169.254.169.254 cloud metadata address on AWS/GCP/Azure),
// CGNAT, multicast, and reserved/documentation blocks.
const IPV4_BLOCKED_RANGES = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function ipv4ToInt(octets) {
  return octets.reduce((acc, o) => acc * 256 + o, 0);
}

function isBlockedIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true; // unparseable — fail closed
  }
  const value = ipv4ToInt(octets);
  return IPV4_BLOCKED_RANGES.some(([base, prefixLength]) => {
    const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIPv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4 address too.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  const firstGroup = normalized.split(':')[0];
  const firstHextet = Number.parseInt(firstGroup || '0', 16) || 0;
  const isUniqueLocal = normalized.startsWith('fc') || normalized.startsWith('fd');
  const isLinkLocal = (firstHextet & 0xffc0) === 0xfe80; // fe80::/10
  return isUniqueLocal || isLinkLocal;
}

function isDisallowedAddress(address, family) {
  return family === 6 ? isBlockedIPv6(address) : isBlockedIPv4(address);
}

function isDisallowedHostname(hostname) {
  const lower = hostname.toLowerCase();
  return DISALLOWED_HOSTNAME_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(suffix));
}

// Node's networking stack connects directly to a literal IP host WITHOUT
// ever calling the custom `lookup` function — DNS resolution only happens
// for hostnames that need it. A URL like http://127.0.0.1/ (or a redirect
// to one) would silently bypass a lookup-only guard entirely. This checks
// the literal-IP case directly; hostnames still need the DNS-resolution-time
// check in `safeLookup` below (a hostname can't be validated by string
// alone — it might resolve to a blocked address, including via rebinding).
function isDisallowedUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return true; // unparseable — fail closed
  }
  const ipVersion = net.isIP(hostname);
  if (ipVersion) return isDisallowedAddress(hostname, ipVersion);
  return isDisallowedHostname(hostname);
}

// Drop-in replacement for the `lookup` option accepted by Node's http/https
// request options (and forwarded by axios). Node's http core calls this with
// the traditional dns.lookup(hostname, options, (err, address, family))
// contract (a single address, not the `{ all: true }` array form) — the
// `all` flag is stripped from the options we forward to guarantee that
// shape back, regardless of what Node happens to pass us.
function safeLookup(hostname, options, callback) {
  if (isDisallowedHostname(hostname)) {
    callback(new Error(`Refusing to fetch a disallowed host: ${hostname}`));
    return;
  }
  const lookupOptions = { ...options, all: false };
  dns.lookup(hostname, lookupOptions, (err, address, family) => {
    if (err) {
      callback(err);
      return;
    }
    if (isDisallowedAddress(address, family)) {
      callback(new Error(`Refusing to fetch a disallowed address: ${address}`));
      return;
    }
    callback(null, address, family);
  });
}

module.exports = { safeLookup, isDisallowedAddress, isDisallowedHostname, isDisallowedUrl };
