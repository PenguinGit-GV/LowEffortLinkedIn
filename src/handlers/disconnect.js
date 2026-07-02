// /disconnect — self-service disconnect & erasure (PLAN.md §2.4).
// No args: clear the LinkedIn connection, keep share history (C7).
// "all": delete the users row entirely — the shares FK cascades, erasing
// share history too (C8). Both variants are idempotent: running them with
// nothing to delete gives the same friendly response.

const copy = require('../copy');

function registerDisconnect(app, { db }) {
  app.command('/disconnect', async ({ command, ack, respond, logger }) => {
    await ack();
    const eraseAll = (command.text || '').trim().toLowerCase() === 'all';
    try {
      if (eraseAll) {
        // ON DELETE CASCADE on shares.slack_user_id erases history with the row.
        await db('users').where({ slack_user_id: command.user_id }).del();
      } else {
        await db('users').where({ slack_user_id: command.user_id }).update({
          linkedin_access_token: null,
          linkedin_person_id: null,
          token_expires_at: null,
          expiry_reminder_sent_at: null,
          updated_at: db.fn.now(),
        });
      }
      await respond({ response_type: 'ephemeral', text: eraseAll ? copy.C8 : copy.C7 });
    } catch (err) {
      logger.error('/disconnect failed', err);
      await respond({
        response_type: 'ephemeral',
        text: '😕 Something went wrong — please try `/disconnect` again.',
      });
    }
  });
}

module.exports = { registerDisconnect };
