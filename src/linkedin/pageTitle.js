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

const HTTP_TIMEOUT_MS = 5_000;
// A title always sits in the first few KB of a well-formed <head>; capping
// the read avoids downloading an entire multi-MB page just for it.
const MAX_BYTES = 65_536;
const MAX_TITLE_LENGTH = 200;
// Identifies honestly, like Slackbot/Twitterbot/facebookexternalhit — many
// sites specifically allow known preview-fetcher UAs.
const USER_AGENT = 'LowEffortLinkedInBot/1.0 (+https://github.com/PenguinGit-GV/LowEffortLinkedIn)';

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
  try {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
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
  }
}

module.exports = { fetchArticleTitle, hostnameTitle, decodeHtmlEntities };
