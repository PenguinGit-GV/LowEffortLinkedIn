const dns = require('dns');
const {
  isDisallowedAddress,
  isDisallowedHostname,
  isDisallowedUrl,
  safeLookup,
} = require('../src/linkedin/ssrfGuard');

describe('isDisallowedAddress', () => {
  test.each([
    ['127.0.0.1', 4, true],
    ['10.0.0.5', 4, true],
    ['172.16.5.1', 4, true],
    ['172.31.255.255', 4, true],
    ['192.168.1.1', 4, true],
    ['169.254.169.254', 4, true], // AWS/GCP/Azure cloud metadata
    ['169.254.0.1', 4, true],
    ['100.64.0.1', 4, true], // CGNAT
    ['0.0.0.0', 4, true],
    ['224.0.0.1', 4, true], // multicast
    ['240.0.0.1', 4, true], // reserved
    ['93.184.216.34', 4, false], // a real public IP
    ['8.8.8.8', 4, false],
    ['172.15.255.255', 4, false], // just outside 172.16.0.0/12
    ['172.32.0.0', 4, false], // just outside 172.16.0.0/12
  ])('IPv4 %s is disallowed=%s', (address, family, expected) => {
    expect(isDisallowedAddress(address, family)).toBe(expected);
  });

  test.each([
    ['::1', 6, true], // loopback
    ['::', 6, true], // unspecified
    ['fe80::1', 6, true], // link-local
    ['fc00::1', 6, true], // unique local
    ['fd12:3456:789a::1', 6, true], // unique local
    ['::ffff:127.0.0.1', 6, true], // IPv4-mapped loopback
    ['::ffff:10.0.0.5', 6, true], // IPv4-mapped private
    ['2001:4860:4860::8888', 6, false], // a real public IPv6 (Google DNS)
  ])('IPv6 %s is disallowed=%s', (address, family, expected) => {
    expect(isDisallowedAddress(address, family)).toBe(expected);
  });
});

describe('isDisallowedHostname', () => {
  test.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['postgres.railway.internal', true],
    ['foo.internal', true],
    ['example.com', false],
    ['notlocalhost.example.com', false],
  ])('%s is disallowed=%s', (hostname, expected) => {
    expect(isDisallowedHostname(hostname)).toBe(expected);
  });
});

describe('isDisallowedUrl', () => {
  test('blocks a literal private/loopback IP in the URL directly, without any DNS lookup', () => {
    expect(isDisallowedUrl('http://127.0.0.1/')).toBe(true);
    expect(isDisallowedUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isDisallowedUrl('http://10.0.0.5:8080/')).toBe(true);
  });

  test('blocks known internal hostname patterns', () => {
    expect(isDisallowedUrl('http://localhost:3000/')).toBe(true);
    expect(isDisallowedUrl('https://postgres.railway.internal/')).toBe(true);
  });

  test('allows an ordinary public-looking hostname (DNS-time validation happens in safeLookup)', () => {
    expect(isDisallowedUrl('https://example.com/post')).toBe(false);
  });

  test('fails closed on an unparseable URL', () => {
    expect(isDisallowedUrl('not a url')).toBe(true);
  });
});

describe('safeLookup', () => {
  const originalLookup = dns.lookup;
  afterEach(() => {
    dns.lookup = originalLookup;
  });

  test('rejects when the hostname is refused before any DNS call', (done) => {
    safeLookup('localhost', {}, (err) => {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('localhost');
      done();
    });
  });

  test('rejects when DNS resolves to a disallowed address (covers rebinding / attacker-controlled domains)', (done) => {
    dns.lookup = (hostname, options, cb) => cb(null, '10.0.0.5', 4);
    safeLookup('evil.example', {}, (err) => {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('10.0.0.5');
      done();
    });
  });

  test('allows a normal resolution to a public address', (done) => {
    dns.lookup = (hostname, options, cb) => cb(null, '93.184.216.34', 4);
    safeLookup('example.com', {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
      done();
    });
  });

  test('propagates a genuine DNS resolution error', (done) => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    dns.lookup = (hostname, options, cb) => cb(dnsError);
    safeLookup('doesnotexist.example', {}, (err) => {
      expect(err).toBe(dnsError);
      done();
    });
  });
});
