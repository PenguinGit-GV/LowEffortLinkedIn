// "Connect your LinkedIn" prompt (C1) — PLAN.md §2.2.
// The connect link carries a signed slack_id token, only ever minted here in
// response to a signature-verified Slack interaction, so /auth/linkedin can't
// be used to bind a LinkedIn account to an arbitrary coworker's Slack ID.

const copy = require('../copy');
const { signToken } = require('../crypto/signedToken');

const CONNECT_LINK_TTL_SECONDS = 15 * 60;
const CONNECT_BUTTON_ACTION_ID = 'connect_linkedin';

function buildConnectUrl(config, slackUserId) {
  const token = signToken(
    { slack_user_id: slackUserId, purpose: 'connect' },
    config.oauthStateSecret,
    CONNECT_LINK_TTL_SECONDS
  );
  return `${config.publicBaseUrl}/auth/linkedin?token=${encodeURIComponent(token)}`;
}

// Ephemeral in the channel where the user clicked (§2.2 step 1). `text` is
// used when blocks are absent/unsupported and doubles as the notification.
async function sendConnectPrompt({ client, config }, { channelId, userId }) {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: copy.C1,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: copy.C1 } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Connect LinkedIn' },
            url: buildConnectUrl(config, userId),
            action_id: CONNECT_BUTTON_ACTION_ID,
          },
        ],
      },
    ],
  });
}

// url buttons still emit a block_actions payload when clicked; Slack shows a
// warning icon on the message unless it's acked. The browser opens the URL
// regardless — nothing else to do here.
function registerConnectPromptAction(app) {
  app.action(CONNECT_BUTTON_ACTION_ID, async ({ ack }) => {
    await ack();
  });
}

// Trigger points 1 & 2 from §2.2: returns the users row only when it holds a
// non-expired LinkedIn connection; null means "run the connect flow". Trigger
// point 3 (LinkedIn 401 at share time) is handled by the Phase 4 share
// pipeline calling sendConnectPrompt directly.
async function getConnection(db, slackUserId) {
  const row = await db('users').where({ slack_user_id: slackUserId }).first();
  if (!row || !row.linkedin_access_token || !row.linkedin_person_id) return null;
  if (!row.token_expires_at || new Date(row.token_expires_at) <= new Date()) return null;
  return row;
}

module.exports = {
  buildConnectUrl,
  sendConnectPrompt,
  registerConnectPromptAction,
  getConnection,
  CONNECT_LINK_TTL_SECONDS,
};
