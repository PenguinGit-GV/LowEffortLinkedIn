// Slack mrkdwn requires &, <, > escaped in user-supplied text; unescaped
// <...> sequences are parsed as control tokens (a pasted "<!channel>" in a
// caption would mass-ping the channel when the bot posts the card).
// Escape at render time only — the database keeps raw text for LinkedIn.

function escapeMrkdwn(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { escapeMrkdwn };
