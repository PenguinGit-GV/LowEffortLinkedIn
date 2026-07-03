// LinkedIn's commentary-field limit and the caption+URL budget rule, shared
// by the /create-post modal and the Edit & Share Custom modal so the two
// can't drift. The destination URL always rides as a trailing line appended
// to the commentary (buildSharePayload in posts.js uses the same separator),
// so caption + separator + URL must fit the limit together, regardless of
// whether an image is attached.

const CAPTION_MAX = 3000;
const COMMENTARY_URL_SEPARATOR = '\n\n';

// -> a user-facing field error when caption+URL overflow the commentary
// limit, or null when they fit (or there is no URL to append).
function captionWithUrlError(caption, destinationUrl) {
  if (!destinationUrl) return null;
  const total = caption.length + COMMENTARY_URL_SEPARATOR.length + destinationUrl.length;
  if (total <= CAPTION_MAX) return null;
  return (
    `The destination link gets appended to the caption on LinkedIn — ` +
    `together they're ${total} characters; the limit is ${CAPTION_MAX}. Please shorten the caption.`
  );
}

module.exports = { CAPTION_MAX, COMMENTARY_URL_SEPARATOR, captionWithUrlError };
