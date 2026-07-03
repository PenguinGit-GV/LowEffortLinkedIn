// Card fan-out helper. A single /create-post can broadcast the same card to
// several advocacy channels (config.advocacyChannelIds); each broadcast's
// (channel, ts) is recorded in post_cards so every card — not just the first —
// gets its share counter updated and its buttons removed at expiry.
//
// Posts created before the post_cards table existed have no rows here; for
// those we fall back to the single (slack_channel_id, slack_message_ts) stored
// on the posts row itself, so old cards keep working.

// cards: [{ slack_channel_id, slack_message_ts }, …]
async function recordPostCards(db, postId, cards) {
  if (!cards || cards.length === 0) return;
  await db('post_cards').insert(
    cards.map((c) => ({
      post_id: postId,
      slack_channel_id: c.slack_channel_id,
      slack_message_ts: c.slack_message_ts,
    }))
  );
}

// Returns [{ slack_channel_id, slack_message_ts }, …] for every card of a post,
// falling back to the post's own primary card columns for pre-migration rows.
async function loadPostCards(db, post) {
  const rows = await db('post_cards')
    .where({ post_id: post.id })
    .select('slack_channel_id', 'slack_message_ts');
  if (rows.length > 0) return rows;
  if (post.slack_channel_id && post.slack_message_ts) {
    return [{ slack_channel_id: post.slack_channel_id, slack_message_ts: post.slack_message_ts }];
  }
  return [];
}

module.exports = { recordPostCards, loadPostCards };
