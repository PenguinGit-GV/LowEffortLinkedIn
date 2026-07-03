// Share flow — PLAN.md §2.3.
// Instant share buttons (A/B/C) and the Edit & Share Custom modal run the
// same pipeline: ack → connection check → idempotency guard → optional image
// fetch+upload → LinkedIn post (real or mock) → shares insert → feedback →
// card counter update → first-share reaction.

const copy = require('../copy');
const { buildPostCard } = require('../blocks/postCard');
const { decryptToken } = require('../crypto/tokenCipher');
const { buildSharePayload } = require('../linkedin/posts');
const { getConnection, sendConnectPrompt } = require('../slack/connectPrompt');
const { postEphemeralSafely } = require('../slack/ephemeral');
const { fetchSlackFile } = require('../slack/files');

const CUSTOM_MODAL_CALLBACK_ID = 'share_custom_modal';
const SHARE_ACTION_PATTERN = /^share_variation_[abc]$/;
// LinkedIn's commentary limit — same cap the /create-post modal enforces.
const CAPTION_MAX = 3000;
const PG_UNIQUE_VIOLATION = '23505';

// Layer 1 of the idempotency guard (§2.3 step 2): absorbs double-clicks
// in-process. Layer 2 is the partial unique index on shares.
const inFlight = new Set();

// A 401 means the member revoked the token — but only on LinkedIn's REST
// endpoints. The image CDN PUT (pre-signed URL) can 401 for its own reasons
// (expired upload URL), which is a share failure, not a revocation.
const is401 = (err) => err.response?.status === 401 && !err.isCdnUpload;
const linkedinErrorText = (err) =>
  err.response?.data?.message || err.data?.error || err.message || 'unknown error';

// Trigger point 3 from §2.2: LinkedIn said 401 mid-share (token revoked on
// their side) — treat identically to "not connected": clear the stored
// connection so getConnection agrees, then run the connect flow.
async function handleRevokedToken({ db, config, client }, { userId, channelId }) {
  await db('users').where({ slack_user_id: userId }).update({
    linkedin_access_token: null,
    linkedin_person_id: null,
    token_expires_at: null,
    expiry_reminder_sent_at: null,
    updated_at: db.fn.now(),
  });
  await sendConnectPrompt({ client, config }, { channelId, userId });
}

// Counter segment of the card's context line (§2.3 step 6), plus the
// nice-to-have ✅ reaction on the first successful share only.
async function updateCardCounter({ db, client, logger }, post) {
  if (!post.slack_channel_id || !post.slack_message_ts) return;
  const [{ count }] = await db('shares')
    .where({ post_id: post.id, status: 'success' })
    .count();
  const shareCount = Number(count);
  try {
    await client.chat.update({
      channel: post.slack_channel_id,
      ts: post.slack_message_ts,
      text: `New post ready to share: ${post.destination_url}`,
      blocks: buildPostCard({ post, shareCount }),
    });
  } catch (err) {
    logger.warn(`Card counter update failed: ${err.data?.error || err.message}`);
  }
  if (shareCount === 1) {
    try {
      await client.reactions.add({
        channel: post.slack_channel_id,
        timestamp: post.slack_message_ts,
        name: 'white_check_mark',
      });
    } catch (err) {
      // The bot can add a given emoji only once; races here are harmless.
      if (err.data?.error !== 'already_reacted') {
        logger.warn(`First-share reaction failed: ${err.data?.error || err.message}`);
      }
    }
  }
}

// Steps 1–6 of §2.3. Runs after the interaction is acked; all feedback is
// ephemeral in the channel where the user clicked.
async function runSharePipeline(
  { config, db, shareClient, client, logger, fetchFile = fetchSlackFile },
  { postId, variation, customText, userId, channelId }
) {
  const lockKey = `${postId}:${userId}`;
  if (inFlight.has(lockKey)) return; // double-click; first click's outcome is coming
  inFlight.add(lockKey);
  try {
    const post = await db('posts').where({ id: postId }).first();
    if (!post) {
      await postEphemeralSafely({ client, logger }, channelId, userId, '😕 This post no longer exists.');
      return;
    }

    // The post-expiry job only removes the card's buttons on its own cron
    // cadence, so a click that lands in that gap (or a stale card left open
    // in someone's browser) must still be rejected here, authoritatively.
    if (post.expires_at && new Date(post.expires_at) <= new Date()) {
      await postEphemeralSafely({ client, logger }, channelId, userId, copy.C12);
      return;
    }

    // Durable idempotency pre-check (Decision #12): one successful share per
    // person per post, any variation.
    const already = await db('shares')
      .where({ post_id: postId, slack_user_id: userId, status: 'success' })
      .first();
    if (already) {
      await postEphemeralSafely({ client, logger }, channelId, userId, copy.C4);
      return;
    }

    // Trigger points 1–2 (§2.2): no/cleared token or expired → connect flow.
    const connection = await getConnection(db, userId);
    if (!connection) {
      await sendConnectPrompt({ client, config }, { channelId, userId });
      return;
    }
    let accessToken;
    try {
      accessToken = decryptToken(connection.linkedin_access_token, config.tokenEncryptionKey);
    } catch {
      // Undecryptable (e.g. rotated TOKEN_ENCRYPTION_KEY) — same as not connected.
      await sendConnectPrompt({ client, config }, { channelId, userId });
      return;
    }

    const commentary =
      variation === 'CUSTOM' ? customText : post[`caption_${variation.toLowerCase()}`];
    if (!commentary) {
      await postEphemeralSafely(
        { client, logger },
        channelId,
        userId,
        '😕 That caption variation is no longer available — try another button on the card.'
      );
      return;
    }

    const recordFailure = async (errorMessage) => {
      await db('shares').insert({
        post_id: postId,
        slack_user_id: userId,
        variation,
        custom_text: variation === 'CUSTOM' ? customText : null,
        status: 'failed',
        error_message: errorMessage.slice(0, 2000),
      });
    };
    const failShare = async (errorMessage) => {
      await recordFailure(errorMessage);
      // LinkedIn error bodies can be huge (payload echoes); an untruncated one
      // would push C6 past Slack's message limit and the user would get
      // nothing at all. The full text is in the shares row.
      const brief =
        errorMessage.length > 400 ? `${errorMessage.slice(0, 400)}…` : errorMessage;
      await postEphemeralSafely(
        { client, logger },
        channelId,
        userId,
        copy.C6(brief, `<@${config.marketerSlackIds[0]}>`)
      );
    };

    // Image (§2.3 step 3): Slack fetch + upload under the SHARER's token —
    // LinkedIn image assets belong to the member who uploads them. Failure is
    // loud (§2.1): sharing without the approved image is not acceptable.
    let imageUrn = null;
    if (post.image_slack_file_id) {
      try {
        const bytes = await fetchFile(
          { client, botToken: config.slackBotToken },
          post.image_slack_file_id
        );
        imageUrn = await shareClient.uploadImage({
          accessToken,
          personId: connection.linkedin_person_id,
          bytes,
        });
      } catch (err) {
        if (is401(err)) {
          await recordFailure('LinkedIn token revoked (401 on image upload)');
          await handleRevokedToken({ db, config, client }, { userId, channelId });
          return;
        }
        logger.error('Share image step failed', err);
        await failShare(`image upload failed: ${linkedinErrorText(err)}`);
        return;
      }
    }

    const payload = buildSharePayload({
      personId: connection.linkedin_person_id,
      commentary,
      destinationUrl: post.destination_url,
      imageUrn,
    });

    let postUrn = null;
    try {
      postUrn = await shareClient.createPost({ accessToken, payload });
    } catch (err) {
      if (is401(err)) {
        await recordFailure('LinkedIn token revoked (401)');
        await handleRevokedToken({ db, config, client }, { userId, channelId });
        return;
      }
      logger.error('LinkedIn post failed', err);
      await failShare(linkedinErrorText(err));
      return;
    }

    try {
      await db('shares').insert({
        post_id: postId,
        slack_user_id: userId,
        variation,
        custom_text: variation === 'CUSTOM' ? customText : null,
        linkedin_post_urn: postUrn,
        status: 'success',
      });
    } catch (err) {
      // Layer 2 caught a race the pre-check missed (e.g. across a restart).
      if (err.code === PG_UNIQUE_VIOLATION) {
        await postEphemeralSafely({ client, logger }, channelId, userId, copy.C4);
        return;
      }
      throw err;
    }

    await postEphemeralSafely({ client, logger }, channelId, userId, copy.C3);
    await updateCardCounter({ db, client, logger }, post);
  } catch (err) {
    logger.error('Share pipeline failed', err);
    await postEphemeralSafely(
      { client, logger },
      channelId,
      userId,
      '😕 Something went wrong sharing this post — please try again.'
    );
  } finally {
    inFlight.delete(lockKey);
  }
}

// Pre-filled with Caption A (§2.3); {post_id, channel_id} rides in
// private_metadata so the submission can run the pipeline and respond in the
// right channel.
function buildCustomShareModal({ post, channelId }) {
  return {
    type: 'modal',
    callback_id: CUSTOM_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ post_id: post.id, channel_id: channelId }),
    title: { type: 'plain_text', text: 'Edit & share' },
    submit: { type: 'plain_text', text: 'Share to LinkedIn' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'custom_caption',
        label: { type: 'plain_text', text: 'Your caption' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          max_length: CAPTION_MAX,
          initial_value: post.caption_a,
        },
      },
    ],
  };
}

function registerShareHandlers(app, { config, db, shareClient, fetchFile }) {
  app.action(SHARE_ACTION_PATTERN, async ({ ack, body, action, client, logger }) => {
    await ack();
    let value;
    try {
      value = JSON.parse(action.value);
    } catch {
      logger.error(`Unparseable share button value: ${action.value}`);
      return;
    }
    if (!value?.post_id || !['A', 'B', 'C'].includes(value.variation)) return;
    await runSharePipeline(
      { config, db, shareClient, client, logger, ...(fetchFile ? { fetchFile } : {}) },
      {
        postId: value.post_id,
        variation: value.variation,
        customText: null,
        userId: body.user.id,
        channelId: body.channel?.id || null,
      }
    );
  });

  app.action('edit_share_custom', async ({ ack, body, action, client, logger }) => {
    await ack();
    try {
      let value;
      try {
        value = JSON.parse(action.value);
      } catch {
        logger.error(`Unparseable custom button value: ${action.value}`);
        return;
      }
      const post = await db('posts').where({ id: value.post_id }).first();
      if (!post) {
        await postEphemeralSafely(
          { client, logger },
          body.channel?.id,
          body.user.id,
          '😕 This post no longer exists.'
        );
        return;
      }
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCustomShareModal({ post, channelId: body.channel?.id || null }),
      });
    } catch (err) {
      // DB or views.open failure — the user clicked and must hear something.
      logger.error('edit_share_custom failed', err);
      await postEphemeralSafely(
        { client, logger },
        body.channel?.id,
        body.user.id,
        '😕 Could not open the editor — please try again.'
      );
    }
  });

  app.view(CUSTOM_MODAL_CALLBACK_ID, async ({ ack, body, view, client, logger }) => {
    let meta = {};
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      // metadata is ours; if malformed, validation below still acks cleanly
    }

    const raw = view.state.values.custom_caption?.value?.value;
    const text = raw && raw.trim() ? raw.trim() : null;
    if (!text) {
      await ack({ response_action: 'errors', errors: { custom_caption: 'A caption is required.' } });
      return;
    }
    if (text.length > CAPTION_MAX) {
      await ack({
        response_action: 'errors',
        errors: {
          custom_caption: `Captions can be at most ${CAPTION_MAX} characters (LinkedIn's limit).`,
        },
      });
      return;
    }

    let post;
    try {
      post = meta.post_id ? await db('posts').where({ id: meta.post_id }).first() : null;
    } catch (err) {
      // Pre-ack DB failure: keep the modal open with a field error instead of
      // letting the ack window lapse into Slack's opaque timeout banner.
      logger.error('Custom share modal post lookup failed', err);
      await ack({
        response_action: 'errors',
        errors: { custom_caption: 'Something went wrong — please try submitting again.' },
      });
      return;
    }
    // With an image, the destination URL is appended to the commentary (§4),
    // so caption + separator + URL must fit the same limit.
    if (post?.image_slack_file_id) {
      const total = text.length + 2 + post.destination_url.length;
      if (total > CAPTION_MAX) {
        await ack({
          response_action: 'errors',
          errors: {
            custom_caption:
              `This post has an image, so the link gets appended to your caption — ` +
              `together they're ${total} characters; the limit is ${CAPTION_MAX}. Please trim it.`,
          },
        });
        return;
      }
    }
    await ack();

    if (!post) {
      await postEphemeralSafely(
        { client, logger },
        meta.channel_id,
        body.user.id,
        '😕 This post no longer exists.'
      );
      return;
    }
    await runSharePipeline(
      { config, db, shareClient, client, logger, ...(fetchFile ? { fetchFile } : {}) },
      {
        postId: post.id,
        variation: 'CUSTOM',
        customText: text,
        userId: body.user.id,
        channelId: meta.channel_id || null,
      }
    );
  });
}

module.exports = {
  registerShareHandlers,
  runSharePipeline,
  buildCustomShareModal,
  CUSTOM_MODAL_CALLBACK_ID,
};
