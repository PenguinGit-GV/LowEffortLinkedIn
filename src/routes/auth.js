// LinkedIn OAuth routes — PLAN.md §2.2 steps 3–5.
// /auth/linkedin: verify the signed connect-link token, mint a signed state,
// redirect to LinkedIn. /auth/linkedin/callback: handle the deny path, verify
// state (CSRF defense), exchange the code, encrypt the token, upsert the user,
// and confirm both in the browser (P1) and in Slack (C2).

const copy = require('../copy');
const pages = require('../pages');
const { signToken, verifyToken } = require('../crypto/signedToken');
const { encryptToken } = require('../crypto/tokenCipher');
const { createSingleUseGuard } = require('../crypto/singleUse');
const defaultLinkedin = require('../linkedin/oauth');

const STATE_TTL_SECONDS = 10 * 60;
// Mock connections mirror LinkedIn's real ~60-day token lifetime so the
// Phase 6 reminder job is exercisable in dev too.
const MOCK_TOKEN_LIFETIME_SECONDS = 60 * 24 * 60 * 60;

// OAuth result pages must never be cached (they reflect a one-time flow) and
// carry no scripts, but nosniff costs nothing.
function sendPage(res, status, html) {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .set('X-Content-Type-Options', 'nosniff')
    .send(html);
}

async function upsertConnection(db, { slackUserId, encryptedToken, personId, expiresAt }) {
  await db('users')
    .insert({
      slack_user_id: slackUserId,
      linkedin_access_token: encryptedToken,
      linkedin_person_id: personId,
      token_expires_at: expiresAt,
      // Fresh token = fresh 60-day window; the reminder job must fire again
      // for this one (§2.2 step 4).
      expiry_reminder_sent_at: null,
      updated_at: db.fn.now(),
    })
    .onConflict('slack_user_id')
    .merge();
}

// C2 is a nicety on top of the P1 page — never fail the flow over it, and
// always send it AFTER the browser response: Slack API slowness (retries can
// run minutes) must not leave the user staring at a spinner.
async function notifyConnected({ slackClient, logger }, slackUserId) {
  try {
    await slackClient.chat.postMessage({ channel: slackUserId, text: copy.C2 });
  } catch (err) {
    logger.warn(
      `Could not send LinkedIn-connected DM to ${slackUserId}: ${err.data?.error || err.message}`
    );
  }
}

function registerAuthRoutes(router, { config, db, slackClient, linkedin, logger = console }) {
  const li = linkedin || defaultLinkedin;
  // States are single-use; connect links stay multi-use within their TTL so a
  // refresh of /auth/linkedin (or a second click on the button) still works.
  const consumeState = createSingleUseGuard();

  router.get('/auth/linkedin', async (req, res) => {
    try {
      const payload = verifyToken(req.query.token, config.oauthStateSecret, 'connect');
      if (!payload || !payload.slack_user_id) {
        sendPage(res, 400, pages.expired());
        return;
      }
      const slackUserId = payload.slack_user_id;

      // Mock mode: no LinkedIn app exists yet, so complete the whole handshake
      // locally — the rest of the product is testable end-to-end (PLAN.md #4).
      if (config.linkedinMockMode) {
        await upsertConnection(db, {
          slackUserId,
          encryptedToken: encryptToken(`mock-token-${slackUserId}`, config.tokenEncryptionKey),
          personId: `mock-${slackUserId}`,
          expiresAt: new Date(Date.now() + MOCK_TOKEN_LIFETIME_SECONDS * 1000),
        });
        sendPage(res, 200, pages.success());
        await notifyConnected({ slackClient, logger }, slackUserId);
        return;
      }

      const state = signToken(
        { slack_user_id: slackUserId, purpose: 'state' },
        config.oauthStateSecret,
        STATE_TTL_SECONDS
      );
      res.redirect(302, li.buildAuthorizationUrl(config, state));
    } catch (err) {
      logger.error('GET /auth/linkedin failed:', err);
      if (!res.headersSent) sendPage(res, 500, pages.error());
    }
  });

  router.get('/auth/linkedin/callback', async (req, res) => {
    try {
      // Deny path first: LinkedIn redirects back with ?error when the user
      // cancels on the consent screen (§2.2 step 4). A cancel is a normal
      // outcome (200/P2); anything else is LinkedIn failing (502) so it shows
      // up in monitoring.
      if (req.query.error) {
        const cancelled = String(req.query.error).startsWith('user_cancelled');
        if (cancelled) {
          sendPage(res, 200, pages.cancelled());
        } else {
          logger.error(`LinkedIn authorization failed: ${String(req.query.error)}`);
          sendPage(res, 502, pages.error());
        }
        return;
      }

      const payload = verifyToken(req.query.state, config.oauthStateSecret, 'state');
      if (!payload || !payload.slack_user_id || !req.query.code || !consumeState(payload)) {
        sendPage(res, 400, pages.expired());
        return;
      }
      const slackUserId = payload.slack_user_id;

      let accessToken;
      let expiresIn;
      let personId;
      try {
        ({ accessToken, expiresIn } = await li.exchangeCodeForToken(config, req.query.code));
        // Guard against schema drift (PLAN.md §10): a 200 with missing fields
        // must fail here, not as an Invalid Date / undefined binding at the
        // upsert below.
        if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
          throw new Error('token response missing access_token/expires_in');
        }
        const userInfo = await li.fetchUserInfo(accessToken);
        personId = userInfo?.sub;
        if (!personId) throw new Error('userinfo response missing sub');
      } catch (err) {
        // Never log the token or the full response; the status line is enough
        // to debug against LinkedIn's docs.
        logger.error(
          `LinkedIn OAuth exchange failed: ${err.response?.status || ''} ${err.message}`
        );
        sendPage(res, 502, pages.error());
        return;
      }

      await upsertConnection(db, {
        slackUserId,
        encryptedToken: encryptToken(accessToken, config.tokenEncryptionKey),
        personId,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      });
      sendPage(res, 200, pages.success());
      await notifyConnected({ slackClient, logger }, slackUserId);
    } catch (err) {
      logger.error('GET /auth/linkedin/callback failed:', err);
      if (!res.headersSent) sendPage(res, 500, pages.error());
    }
  });
}

module.exports = { registerAuthRoutes, STATE_TTL_SECONDS };
