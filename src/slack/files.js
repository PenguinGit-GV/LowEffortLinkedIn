// Downloads the marketer's attached image from Slack at share time
// (PLAN.md §2.3 step 3; needs the files:read scope, §6).

const axios = require('axios');

const HTTP_TIMEOUT_MS = 15_000;
// Slack caps free-plan uploads well below this; a bound keeps a pathological
// file from ballooning memory.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function fetchSlackFile({ client, botToken }, fileId) {
  const info = await client.files.info({ file: fileId });
  const url = info.file?.url_private_download || info.file?.url_private;
  if (!url) throw new Error('Slack file has no downloadable URL');

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    responseType: 'arraybuffer',
    timeout: HTTP_TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_BYTES,
  });

  // Slack serves an HTML login page (status 200) instead of bytes when the
  // token lacks access — that must fail loudly, not get uploaded to LinkedIn.
  const contentType = res.headers['content-type'] || '';
  if (contentType.includes('text/html')) {
    throw new Error('Slack returned HTML instead of the file (check the files:read scope)');
  }
  return Buffer.from(res.data);
}

module.exports = { fetchSlackFile };
