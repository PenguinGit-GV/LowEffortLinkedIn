// LinkedIn Posts + Images API — PLAN.md §4.
// The payload shapes follow the plan's representative examples; the plan
// flags them for verification against LinkedIn's live docs once API access
// is granted (mock mode covers everything until then).

const crypto = require('crypto');
const axios = require('axios');

const POSTS_URL = 'https://api.linkedin.com/rest/posts';
const IMAGES_URL = 'https://api.linkedin.com/rest/images';
const HTTP_TIMEOUT_MS = 15_000;

// content is a oneOf: media OR nothing — never our own article attachment.
// The destination URL always rides as a trailing line in the commentary
// text; LinkedIn auto-detects a bare URL there and unfurls it itself via its
// own crawler, the same as when a person pastes a link into the share box.
//
// This used to build an explicit `content.article` (with `source` +
// `title`) instead. That required us to fetch the destination page's real
// <title> server-side (src/linkedin/pageTitle.js) — which reliably failed
// for real destination sites: cloud-hosting IP ranges (Railway included)
// are commonly blocked/challenged by WAFs like Cloudflare on IP reputation
// alone, independent of headers, so no amount of User-Agent/header tuning
// on our end could fix it. LinkedIn's own crawler runs from LinkedIn's
// infrastructure and is one of the most widely allowlisted bots on the
// web, so letting it do the unfurl sidesteps the problem entirely instead
// of trying to disguise our own fetch.
function buildSharePayload({ personId, commentary, destinationUrl, imageUrn }) {
  const base = {
    author: `urn:li:person:${personId}`,
    commentary: `${commentary}\n\n${destinationUrl}`,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED' },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (imageUrn) {
    return { ...base, content: { media: { id: imageUrn } } };
  }
  return base;
}

// Client for the per-share LinkedIn calls. In mock mode nothing leaves the
// process — shares "succeed" with fake URNs so the whole flow is exercisable
// before LinkedIn approves API access (Decision #4).
function createShareClient(config, { logger = console } = {}) {
  if (config.linkedinMockMode) {
    return {
      async uploadImage({ personId }) {
        logger.log(`[linkedin-mock] image upload for urn:li:person:${personId}`);
        return `urn:li:image:mock-${crypto.randomBytes(6).toString('hex')}`;
      },
      async createPost({ payload }) {
        logger.log(`[linkedin-mock] post by ${payload.author} (${payload.commentary.length} chars)`);
        return `urn:li:share:mock-${crypto.randomBytes(6).toString('hex')}`;
      },
    };
  }

  const restHeaders = (accessToken) => ({
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': config.linkedinVersion,
    'X-Restli-Protocol-Version': '2.0.0',
  });

  return {
    // initializeUpload → PUT raw bytes → image URN (§4). Runs under the
    // SHARER's token: LinkedIn image assets belong to the uploading member.
    async uploadImage({ accessToken, personId, bytes }) {
      const init = await axios.post(
        `${IMAGES_URL}?action=initializeUpload`,
        { initializeUploadRequest: { owner: `urn:li:person:${personId}` } },
        { headers: restHeaders(accessToken), timeout: HTTP_TIMEOUT_MS }
      );
      const { uploadUrl, image } = init.data.value;
      try {
        await axios.put(uploadUrl, bytes, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/octet-stream',
          },
          timeout: HTTP_TIMEOUT_MS,
          maxBodyLength: Infinity,
        });
      } catch (err) {
        // Pre-signed CDN URL — a 401 here (e.g. expired upload URL) is a
        // share failure, NOT a token revocation. Tag it so the pipeline
        // doesn't send the user through the reconnect flow.
        err.isCdnUpload = true;
        throw err;
      }
      return image;
    },

    // 201's x-restli-id header carries the new post's URN (§4).
    async createPost({ accessToken, payload }) {
      const res = await axios.post(POSTS_URL, payload, {
        headers: restHeaders(accessToken),
        timeout: HTTP_TIMEOUT_MS,
      });
      return res.headers['x-restli-id'] || null;
    },
  };
}

module.exports = { buildSharePayload, createShareClient };
