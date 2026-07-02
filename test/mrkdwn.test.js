const { escapeMrkdwn } = require('../src/mrkdwn');
const copy = require('../src/copy');

describe('escapeMrkdwn', () => {
  test('escapes the three mrkdwn control characters, ampersand first', () => {
    expect(escapeMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeMrkdwn('&lt;')).toBe('&amp;lt;'); // no double-unescape trickery
  });

  test('neutralizes Slack control sequences', () => {
    expect(escapeMrkdwn('hello <!channel> world')).toBe('hello &lt;!channel&gt; world');
  });

  test('leaves plain text untouched', () => {
    expect(escapeMrkdwn('just a caption, nothing special')).toBe(
      'just a caption, nothing special'
    );
  });
});

describe('C6 sanitizes the LinkedIn-provided error string', () => {
  test('escapes mrkdwn and strips backticks', () => {
    const message = copy.C6('boom ` <!channel> & fail', '<@U_MARKETER>');
    expect(message).not.toContain('<!channel>');
    expect(message).toContain('&lt;!channel&gt;');
    expect(message).not.toContain('` <');
    expect(message).toContain('<@U_MARKETER>');
  });
});
