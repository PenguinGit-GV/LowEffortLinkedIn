// The dashboard shell — like ../../src/pages.js, this must never interpolate
// request data into the HTML string (renderDashboard takes no arguments at
// all, which is the point: every dynamic value is fetched and rendered
// client-side via textContent/createElement, not server-side templating).

const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createServer } = require('../../src/server');
const { signToken } = require('../../src/crypto/signedToken');
const { renderDashboard } = require('../../src/admin/pages');
const { fakeAdminDb } = require('./fakeAdminDb');

const ADMIN_SESSION_SECRET = 'admin-session-secret';

function testConfig(extra = {}) {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
    ADMIN_UI_ENABLED: 'true',
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    ADMIN_SESSION_SECRET,
    ...extra,
  });
}

const baseOverrides = {
  authorize: async () => ({ botToken: 'xoxb-test', botId: 'B000', botUserId: 'U000' }),
  logLevel: 'error',
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
};

function sessionCookie(slackUserId = 'U111') {
  const token = signToken(
    { slack_user_id: slackUserId, purpose: 'admin_session' },
    ADMIN_SESSION_SECRET,
    12 * 60 * 60
  );
  return `admin_session=${encodeURIComponent(token)}`;
}

describe('renderDashboard', () => {
  test('takes no arguments and produces a static, self-contained shell', () => {
    expect(renderDashboard.length).toBe(0);
    const html = renderDashboard();
    expect(html).toContain('<div id="config-list"></div>');
    expect(html).toContain('<div id="audit-log"></div>');
    // No server-side string interpolation of anything resembling a fetched
    // config value or template placeholder leaking into the shell.
    expect(html).not.toMatch(/\$\{/);
  });
});

describe('GET /admin', () => {
  function buildApp() {
    const { db } = fakeAdminDb();
    const { receiver } = createServer(testConfig(), db, baseOverrides);
    return request(receiver.app);
  }

  test('redirects to /admin/login without a session', async () => {
    const res = await buildApp().get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  test('serves the dashboard for an authenticated marketer', async () => {
    const res = await buildApp().get('/admin').set('Cookie', sessionCookie());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('Environment Variables');
  });
});
