// Resolves the LinkedIn article title from the destination URL's real page
// <title> — a plain hostname ("example.com") was the stopgap that shipped to
// unblock the "content.article.title is required" schema-drift bug; a real
// page title reads far better in the LinkedIn link preview.
//
// Runs once, at /create-post time (not per-share): the title is stored on
// the post row and reused by every employee who shares it, so a slow or
// flaky source site never adds latency or a new failure mode to the actual
// share click. Any failure — timeout, non-HTML response, no <title> tag,
// blocked request — falls back to the hostname rather than propagating.

const axios = require('axios');
const { safeLookup, isDisallowedUrl } = require('./ssrfGuard');

const HTTP_TIMEOUT_MS = 5_000;
// A title always sits in the first few KB of a well-formed <head>; capping
// the read avoids downloading an entire multi-MB page just for it.
const MAX_BYTES = 65_536;
const MAX_TITLE_LENGTH = 200;
// Use a generic browser UA to avoid being blocked by WAFs that reject bots.
// Some sites (like getvocal.ai) have strict rules against bot identifiers.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const key = entity.toLowerCase();
    return NAMED_ENTITIES[key] ?? match;
  });
}

function hostnameTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url; // already URL-validated at /create-post; belt and braces
  }
}

// Reads chunks off an HTTP response stream until either a closing </title>
// has appeared or maxBytes is reached, then aborts the connection — the rest
// of the page is never downloaded.
function readUntilTitleOrLimit(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
      stream.on('error', () => {}); // swallow any post-destroy error emission
      stream.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    stream.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      // Checked against the full accumulated text, not just this chunk —
      // </title> can straddle a chunk boundary on a real HTTP stream.
      if (received >= maxBytes || /<\/title>/i.test(Buffer.concat(chunks).toString('utf8'))) {
        finish();
      }
    });
    stream.on('end', finish);
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// Always resolves to a non-empty string — real page title on success,
// hostname on any failure.
async function fetchArticleTitle(url, { logger = console } = {}) {
  const fallback = hostnameTitle(url);
  // A literal-IP URL (or a redirect to one) never invokes the `lookup`
  // option at all — Node connects directly, skipping DNS resolution
  // entirely — so it needs this separate, explicit check.
  if (isDisallowedUrl(url)) {
    logger.warn?.(`Refusing to fetch a disallowed URL: ${url}`);
    return fallback;
  }
  // axios's `timeout` is a socket-INACTIVITY timeout (Node's req.setTimeout):
  // a server that trickles even one byte every few seconds never triggers
  // it, so it doesn't actually bound total request time. This timer does —
  // it fires on wall-clock elapsed time regardless of activity, and aborts
  // the in-flight request/stream so nothing is left running in the
  // background once we give up.
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 5,
      signal: controller.signal,
      // Validates every hostname actually resolved — including each
      // redirect hop, since Node/follow-redirects re-invoke `lookup` per
      // hop — against private/internal ranges (src/linkedin/ssrfGuard.js).
      // destination_url is marketer-supplied, not arbitrary public input,
      // but a marketer account is still a lower trust tier than the server.
      lookup: safeLookup,
      // `lookup` alone misses a redirect straight to a literal IP (DNS
      // resolution never happens for those) — this closes that gap too.
      beforeRedirect: (redirectOptions) => {
        const target = redirectOptions.href || `${redirectOptions.protocol}//${redirectOptions.hostname}${redirectOptions.path || ''}`;
        if (isDisallowedUrl(target)) {
          throw new Error(`Refusing to follow a redirect to a disallowed URL: ${target}`);
        }
      },
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const contentType = res.headers['content-type'] || '';
    if (!contentType.includes('text/html')) {
      res.data.destroy();
      return fallback;
    }

    const html = await readUntilTitleOrLimit(res.data, MAX_BYTES);
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) return fallback;

    const title = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
    if (!title) return fallback;
    return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
  } catch (err) {
    logger.warn?.(`Could not fetch page title for ${url}: ${err.message}`);
    return fallback;
  } finally {
    clearTimeout(hardTimeout);
  }
}

module.exports = { fetchArticleTitle, hostnameTitle, decodeHtmlEntities };
