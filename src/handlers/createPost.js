// /create-post flow — PLAN.md §2.1.
// Slash command (marketer-only) opens a modal; view submission validates,
// inserts the post, broadcasts the card, and stores the card's channel/ts.

const copy = require('../copy');
const { buildPostCard } = require('../blocks/postCard');
const { escapeMrkdwn } = require('../mrkdwn');
const { postEphemeralSafely } = require('../slack/ephemeral');
const { MAX_POST_EXPIRY_HOURS } = require('../config');

const MODAL_CALLBACK_ID = 'create_post_modal';
// LinkedIn's commentary field limit (PLAN.md §2.1); enforced client-side via
// max_length and re-checked server-side on submit.
const CAPTION_MAX = 3000;
// The card renders the URL inside a section block (3000-char mrkdwn limit)
// behind a ~32-char prefix, and escaping can grow the text further — bound the
// input well below that.
const URL_MAX = 2500;
const SECTION_TEXT_MAX = 3000;
const URL_SECTION_BUDGET = 2900;

function buildModal({ channelId, defaultExpiryHours }) {
  const captionInput = (blockId, label, optional) => ({
    type: 'input',
    block_id: blockId,
    optional,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
      max_length: CAPTION_MAX,
    },
  });

  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ channel_id: channelId }),
    title: { type: 'plain_text', text: 'Create post' },
    submit: { type: 'plain_text', text: 'Broadcast' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'destination_url',
        label: { type: 'plain_text', text: 'Destination URL' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          max_length: URL_MAX,
          placeholder: { type: 'plain_text', text: 'https://…' },
        },
      },
      captionInput('caption_a', 'Caption Variation A', false),
      captionInput('caption_b', 'Caption Variation B (optional)', true),
      captionInput('caption_c', 'Caption Variation C (optional)', true),
      {
        type: 'input',
        block_id: 'image',
        optional: true,
        label: { type: 'plain_text', text: 'Image (optional)' },
        element: {
          type: 'file_input',
          action_id: 'value',
          filetypes: ['png', 'jpg', 'jpeg', 'gif'],
          max_files: 1,
        },
      },
      {
        type: 'input',
        block_id: 'expiry_hours',
        optional: true,
        label: { type: 'plain_text', text: `Sharing window, in hours (default ${defaultExpiryHours})` },
        element: {
          type: 'number_input',
          action_id: 'value',
          is_decimal_allowed: false,
          min_value: '1',
          max_value: String(MAX_POST_EXPIRY_HOURS),
          placeholder: { type: 'plain_text', text: String(defaultExpiryHours) },
        },
      },
    ],
  };
}

// state.values → { parsed, errors }. errors is null when valid; otherwise a
// { block_id: message } map for ack({ response_action: 'errors' }).
function parseSubmission(values, { defaultExpiryHours } = {}) {
  const text = (blockId) => {
    const raw = values[blockId]?.value?.value;
    return raw && raw.trim() ? raw.trim() : null;
  };

  const errors = {};
  const destinationUrl = text('destination_url');
  if (!destinationUrl) {
    errors.destination_url = 'A destination URL is required.';
  } else {
    let parsedUrl;
    try {
      parsedUrl = new URL(destinationUrl);
    } catch {
      errors.destination_url = 'This doesn’t look like a valid URL.';
    }
    if (parsedUrl && !['http:', 'https:'].includes(parsedUrl.protocol)) {
      errors.destination_url = 'The URL must start with http:// or https://.';
    }
    if (
      !errors.destination_url &&
      (destinationUrl.length > URL_MAX || escapeMrkdwn(destinationUrl).length > URL_SECTION_BUDGET)
    ) {
      errors.destination_url = `This URL is too long to display in Slack (keep it under ${URL_MAX} characters).`;
    }
  }

  const captionA = text('caption_a');
  if (!captionA) {
    errors.caption_a = 'Caption A is required.';
  }
  for (const blockId of ['caption_a', 'caption_b', 'caption_c']) {
    const value = text(blockId);
    if (!value) continue;
    if (value.length > CAPTION_MAX) {
      errors[blockId] = `Captions can be at most ${CAPTION_MAX} characters (LinkedIn's limit).`;
    } else if (escapeMrkdwn(value).length > SECTION_TEXT_MAX) {
      // &, <, > are encoded for display, so a caption near the limit that's
      // heavy on those characters can overflow Slack's section block.
      errors[blockId] =
        'This caption is too long to display in Slack once special characters (&, <, >) are encoded — please trim it slightly.';
    }
  }

  const imageFileId = values.image?.value?.files?.[0]?.id || null;

  // number_input's client-side min/max already guard the common case; this
  // is the server-side re-check the rest of the modal's fields also get.
  const expiryHoursRaw = values.expiry_hours?.value?.value;
  let expiryHours = defaultExpiryHours;
  if (expiryHoursRaw !== undefined && expiryHoursRaw !== null && expiryHoursRaw !== '') {
    const parsedHours = Number.parseFloat(expiryHoursRaw);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0 || parsedHours > MAX_POST_EXPIRY_HOURS) {
      errors.expiry_hours = `Enter a number between 1 and ${MAX_POST_EXPIRY_HOURS}, or leave it blank for the default.`;
    } else {
      expiryHours = parsedHours;
    }
  }

  // With an image, the LinkedIn payload appends the URL to the commentary
  // (§4), so caption + "\n\n" + URL must also fit the 3000-char limit.
  if (imageFileId && destinationUrl && !errors.destination_url) {
    for (const blockId of ['caption_a', 'caption_b', 'caption_c']) {
      const value = text(blockId);
      if (!value || errors[blockId]) continue;
      const total = value.length + 2 + destinationUrl.length;
      if (total > CAPTION_MAX) {
        errors[blockId] =
          `With an image attached, the link gets appended to the caption on LinkedIn — ` +
          `together they're ${total} characters; the limit is ${CAPTION_MAX}. Please shorten this caption.`;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { parsed: null, errors };
  return {
    parsed: {
      destination_url: destinationUrl,
      caption_a: captionA,
      caption_b: text('caption_b'),
      caption_c: text('caption_c'),
      image_slack_file_id: imageFileId,
      expiry_hours: expiryHours,
    },
    errors: null,
  };
}

// Runs after ack(): insert → broadcast → store card location → confirm.
// If the broadcast fails on all channels, the orphaned row is removed so the
// posts table only ever holds posts that actually have a card. Broadcasts to
// all channels and stores the first successful post's location for tracking.
async function publishPost({ db, client, config, logger }, { parsed, userId, originChannelId }) {
  const { expiry_hours: expiryHours, ...postFields } = parsed;
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
  const [{ id: postId }] = await db('posts')
    .insert({ ...postFields, created_by_slack_id: userId, expires_at: expiresAt })
    .returning('id');

  const post = { ...postFields, id: postId, created_by_slack_id: userId, expires_at: expiresAt };
  const broadcasts = [];
  const errors = [];

  for (const channelId of config.advocacyChannelIds) {
    try {
      const broadcast = await client.chat.postMessage({
        channel: channelId,
        text: `New post ready to share: ${parsed.destination_url}`,
        blocks: buildPostCard({ post, shareCount: 0 }),
        unfurl_links: true,
      });
      broadcasts.push({ channel: channelId, ...broadcast });
    } catch (err) {
      errors.push({
        channel: channelId,
        error: err.data?.error || err.message,
      });
    }
  }

  if (broadcasts.length === 0) {
    await db('posts').where({ id: postId }).del();
    const channelList = config.advocacyChannelIds.map((c) => `<#${c}>`).join(', ');
    const reason =
      errors.some((e) => ['channel_not_found', 'not_in_channel'].includes(e.error)) &&
      errors.length === config.advocacyChannelIds.length
        ? `I can't post to ${channelList} — are the channel IDs right and is the app allowed there?`
        : `Broadcasting failed: ${errors.map((e) => `\`${e.error}\``).join(', ')}.`;
    await postEphemeralSafely({ client, logger }, originChannelId, userId, `😕 ${reason}`);
    return;
  }

  const firstBroadcast = broadcasts[0];
  await db('posts')
    .where({ id: postId })
    .update({ slack_channel_id: firstBroadcast.channel, slack_message_ts: firstBroadcast.ts });

  const channelList = config.advocacyChannelIds.map((c) => `<#${c}>`).join(', ');
  await postEphemeralSafely(
    { client, logger },
    originChannelId,
    userId,
    copy.C9(channelList)
  );
}

function registerCreatePost(app, { config, db }) {
  app.command('/create-post', async ({ command, ack, respond, client, logger }) => {
    await ack();
    if (!config.marketerSlackIds.includes(command.user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: copy.C10(`<@${config.marketerSlackIds[0]}>`),
      });
      return;
    }
    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildModal({ channelId: command.channel_id, defaultExpiryHours: config.defaultPostExpiryHours }),
      });
    } catch (err) {
      logger.error('views.open failed', err);
      await respond({
        response_type: 'ephemeral',
        text: '😕 Could not open the post form — please try `/create-post` again.',
      });
    }
  });

  app.view(MODAL_CALLBACK_ID, async ({ ack, body, view, client, logger }) => {
    const { parsed, errors } = parseSubmission(view.state.values, {
      defaultExpiryHours: config.defaultPostExpiryHours,
    });
    if (errors) {
      await ack({ response_action: 'errors', errors });
      return;
    }
    await ack();

    let originChannelId = null;
    try {
      originChannelId = JSON.parse(view.private_metadata || '{}').channel_id || null;
    } catch {
      // metadata is ours; if it's somehow malformed, just skip the confirmation
    }

    try {
      await publishPost(
        { db, client, config, logger },
        { parsed, userId: body.user.id, originChannelId }
      );
    } catch (err) {
      logger.error('publishPost failed', err);
      await postEphemeralSafely(
        { client, logger },
        originChannelId,
        body.user.id,
        '😕 Something went wrong saving your post — please try again.'
      );
    }
  });
}

module.exports = {
  registerCreatePost,
  buildModal,
  parseSubmission,
  publishPost,
  CAPTION_MAX,
  URL_MAX,
};
