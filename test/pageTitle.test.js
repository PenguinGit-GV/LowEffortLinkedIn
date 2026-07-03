jest.mock('axios');
const axios = require('axios');
const { EventEmitter } = require('events');
const { fetchArticleTitle, hostnameTitle, decodeHtmlEntities } = require('../src/linkedin/pageTitle');

// A minimal fake response stream: emits the given chunks (or an error), and
// records whether it was destroyed early (proving we didn't keep reading).
function fakeHtmlStream(html, { chunkSize = html.length } = {}) {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.destroy = jest.fn(() => {
    stream.destroyed = true;
  });
  process.nextTick(() => {
    for (let i = 0; i < html.length; i += chunkSize) {
      stream.emit('data', Buffer.from(html.slice(i, i + chunkSize)));
    }
    stream.emit('end');
  });
  return stream;
}

function mockHtmlResponse(html, { contentType = 'text/html; charset=utf-8', chunkSize } = {}) {
  axios.get.mockResolvedValue({
    headers: { 'content-type': contentType },
    data: fakeHtmlStream(html, { chunkSize }),
  });
}

const quiet = { warn: jest.fn() };

describe('fetchArticleTitle', () => {
  beforeEach(() => jest.resetAllMocks());

  test('extracts and decodes the real page title', async () => {
    mockHtmlResponse('<html><head><title>AT&amp;T &#8212; Home</title></head></html>');
    const title = await fetchArticleTitle('https://example.com/post', { logger: quiet });
    expect(title).toBe('AT&T — Home');
  });

  test('sends a browser-like User-Agent to avoid WAF blocks', async () => {
    mockHtmlResponse('<title>Hi</title>');
    await fetchArticleTitle('https://example.com', { logger: quiet });
    const [, opts] = axios.get.mock.calls[0];
    expect(opts.headers['User-Agent']).toContain('Mozilla');
  });

  test('sends client-hint headers matching the spoofed User-Agent', async () => {
    // A browser-like UA with none of these looks more like a spoofed
    // request to a WAF than a plain, honest bot UA would.
    mockHtmlResponse('<title>Hi</title>');
    await fetchArticleTitle('https://example.com', { logger: quiet });
    const [, opts] = axios.get.mock.calls[0];
    expect(opts.headers['Sec-CH-UA']).toContain('Chromium');
    expect(opts.headers['Sec-CH-UA-Mobile']).toBe('?0');
    expect(opts.headers['Sec-CH-UA-Platform']).toBe('"Linux"');
    expect(opts.headers['Sec-Fetch-Dest']).toBe('document');
    expect(opts.headers['Sec-Fetch-Mode']).toBe('navigate');
    expect(opts.headers['Sec-Fetch-Site']).toBe('none');
    expect(opts.headers['Sec-Fetch-User']).toBe('?1');
  });

  test('collapses internal whitespace/newlines', async () => {
    mockHtmlResponse('<title>\n  Line one\n  Line two  </title>');
    const title = await fetchArticleTitle('https://example.com', { logger: quiet });
    expect(title).toBe('Line one Line two');
  });

  test('finds the title even when it arrives split across multiple chunks', async () => {
    mockHtmlResponse('<html><head><title>Chunked Title</title></head></html>', { chunkSize: 5 });
    const title = await fetchArticleTitle('https://example.com', { logger: quiet });
    expect(title).toBe('Chunked Title');
  });

  test('falls back to the hostname when there is no <title> tag', async () => {
    mockHtmlResponse('<html><head></head><body>no title here</body></html>');
    const title = await fetchArticleTitle('https://www.example.com/post', { logger: quiet });
    expect(title).toBe('example.com');
  });

  test('falls back to the hostname for a non-HTML response, without reading the body', async () => {
    const stream = fakeHtmlStream('%PDF-1.4 binary garbage');
    axios.get.mockResolvedValue({ headers: { 'content-type': 'application/pdf' }, data: stream });
    const title = await fetchArticleTitle('https://example.com/file.pdf', { logger: quiet });
    expect(title).toBe('example.com');
    expect(stream.destroy).toHaveBeenCalled();
  });

  test('falls back to the hostname on a request timeout/network error', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }));
    const title = await fetchArticleTitle('https://slow.example.com/post', { logger: quiet });
    expect(title).toBe('slow.example.com');
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('slow.example.com'));
  });

  test('falls back to the hostname when the title decodes to empty/whitespace', async () => {
    mockHtmlResponse('<title>   </title>');
    const title = await fetchArticleTitle('https://example.com', { logger: quiet });
    expect(title).toBe('example.com');
  });

  test('stops reading once maxBytes worth of page has been seen, without a title', async () => {
    // No </title> anywhere in this huge blob — must terminate via the byte
    // cap rather than buffering the "whole" (mocked-infinite) page.
    const huge = '<html><head>' + 'x'.repeat(200_000);
    mockHtmlResponse(huge, { chunkSize: 8192 });
    const title = await fetchArticleTitle('https://example.com', { logger: quiet });
    expect(title).toBe('example.com');
  });

  test('truncates an excessively long title', async () => {
    mockHtmlResponse(`<title>${'A'.repeat(300)}</title>`);
    const title = await fetchArticleTitle('https://example.com', { logger: quiet });
    expect(title.length).toBe(200);
    expect(title.endsWith('…')).toBe(true);
  });

  test('refuses a disallowed URL up front, without ever calling axios', async () => {
    const title = await fetchArticleTitle('http://127.0.0.1:9999/', { logger: quiet });
    expect(title).toBe('127.0.0.1');
    expect(axios.get).not.toHaveBeenCalled();
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('disallowed URL'));
  });

  test('passes a lookup guard and a beforeRedirect guard to axios', async () => {
    mockHtmlResponse('<title>Hi</title>');
    await fetchArticleTitle('https://example.com', { logger: quiet });
    const [, opts] = axios.get.mock.calls[0];
    expect(typeof opts.lookup).toBe('function');
    expect(typeof opts.beforeRedirect).toBe('function');
    // A redirect to a disallowed target must be rejected by the hook itself.
    expect(() => opts.beforeRedirect({ href: 'http://169.254.169.254/latest/meta-data/' })).toThrow(
      /disallowed/
    );
    // An ordinary redirect target is left alone.
    expect(() => opts.beforeRedirect({ href: 'https://example.com/other-page' })).not.toThrow();
  });

  test('a connection that never goes idle still times out via the wall-clock guard, not just inactivity', async () => {
    jest.useFakeTimers();
    try {
      const stream = new EventEmitter();
      stream.destroy = jest.fn();
      axios.get.mockImplementation((url, opts) => {
        // Mirrors what a real abort does to the underlying stream — proven
        // against a real hanging connection in manual verification (see PR
        // description); this tests that fetchArticleTitle reacts correctly.
        opts.signal.addEventListener('abort', () => {
          stream.emit('error', Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
        });
        return Promise.resolve({ headers: { 'content-type': 'text/html' }, data: stream });
      });

      const pending = fetchArticleTitle('https://slow-drip.example.com/post', { logger: quiet });
      // Plain advanceTimersByTime fires the timer synchronously, before the
      // pending axios promise (and thus the stream's own listener setup)
      // has had a chance to resolve — the async variant properly interleaves
      // microtask flushes with timer advancement.
      await jest.advanceTimersByTimeAsync(5000);
      const title = await pending;
      expect(title).toBe('slow-drip.example.com');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('hostnameTitle', () => {
  test('strips a leading www.', () => {
    expect(hostnameTitle('https://www.example.com/blog/post?x=1')).toBe('example.com');
  });

  test('falls back to the raw string if URL parsing fails', () => {
    expect(hostnameTitle('not-a-valid-url')).toBe('not-a-valid-url');
  });
});

describe('decodeHtmlEntities', () => {
  test('decodes common named entities', () => {
    expect(decodeHtmlEntities('AT&amp;T &lt;3 &quot;you&quot;')).toBe('AT&T <3 "you"');
  });

  test('decodes numeric decimal and hex entities', () => {
    expect(decodeHtmlEntities('&#8212;')).toBe('—');
    expect(decodeHtmlEntities('&#x2014;')).toBe('—');
  });

  test('leaves unrecognized entities untouched', () => {
    expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
  });
});
