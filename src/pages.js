// Browser pages for the OAuth flow — PLAN.md §8 (P1–P3), plus a generic
// failure page for LinkedIn-side errors the plan's table doesn't cover.
// All content is static — no request data is ever interpolated, so there is
// no XSS surface here.

function renderPage({ title, heading, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f8f8f8; color: #1d1c1d; }
    main { max-width: 26rem; padding: 2.5rem; background: #fff; border-radius: 12px;
           box-shadow: 0 1px 4px rgba(0,0,0,.1); text-align: center; }
    h1 { font-size: 1.3rem; margin: 0 0 .75rem; }
    p  { margin: 0; line-height: 1.5; color: #444; }
  </style>
</head>
<body><main><h1>${heading}</h1><p>${body}</p></main></body>
</html>`;
}

module.exports = {
  // P1
  success: () =>
    renderPage({
      title: 'LinkedIn connected',
      heading: '✅ Success!',
      body: 'Your LinkedIn is connected. You can close this tab and head back to Slack.',
    }),
  // P2
  cancelled: () =>
    renderPage({
      title: 'Nothing connected',
      heading: 'No worries — nothing was connected.',
      body:
        "You cancelled on LinkedIn's side. Head back to Slack and click the connect " +
        "button whenever you're ready.",
    }),
  // P3
  expired: () =>
    renderPage({
      title: 'Link expired',
      heading: 'This link has expired.',
      body: 'Go back to Slack and click the connect button again to get a fresh one.',
    }),
  error: () =>
    renderPage({
      title: 'Something went wrong',
      heading: 'Something went wrong. 😕',
      body:
        'We couldn’t finish connecting your LinkedIn. Head back to Slack and click ' +
        'the connect button to try again.',
    }),
};
