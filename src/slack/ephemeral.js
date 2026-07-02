// Ephemeral confirmations/feedback are niceties — never fail a flow because
// one couldn't be delivered (e.g. a context where the bot can't post).

async function postEphemeralSafely({ client, logger }, channel, user, text) {
  if (!channel) return;
  try {
    await client.chat.postEphemeral({ channel, user, text });
  } catch (err) {
    logger?.warn?.(`Could not send ephemeral message: ${err.data?.error || err.message}`);
  }
}

module.exports = { postEphemeralSafely };
