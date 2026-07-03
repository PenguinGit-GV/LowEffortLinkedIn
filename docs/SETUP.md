# Phase 0 Setup Guide

Everything in this guide happens in browser dashboards — no code required. Do the
steps **in order**: Railway first, because its public domain is needed by both the
Slack manifest and the LinkedIn redirect URL.

You'll collect values as you go; at the end they all land in Railway's service
variables. [`.env.example`](../.env.example) is the checklist of what you're
collecting.

**Prerequisites**
- Admin (or app-approval) access to the Dr. Claw Development Slack workspace.
- A LinkedIn account, and a **LinkedIn company page** you admin — LinkedIn requires
  every developer app to be associated with a page. If Dr. Claw Development doesn't
  have one yet, create it first (linkedin.com → For Business → Create a Company Page);
  it takes ~2 minutes.
- A Railway account (railway.com).

---

## 1. Railway — project, Postgres, and your public domain (~5 min)

1. Railway dashboard → **New Project** → **Empty Project**. Name it
   `loweffortlinkedin`.
2. In the project: **Create** → **Database** → **Add PostgreSQL**.
3. **Create** → **Empty Service** (this will run the app; you'll connect the GitHub
   repo in Phase 6, but creating it now mints the domain). Name it `app`.
4. On the `app` service → **Settings** → **Networking** → **Generate Domain**.
   Copy it — something like `loweffortlinkedin-production.up.railway.app`.
   This domain is `PUBLIC_BASE_URL` and gets pasted into the Slack manifest and
   LinkedIn redirect settings below.
5. On the Postgres service → **Variables** tab: note where `DATABASE_URL` lives.
   The `app` service can reference it directly
   (`${{Postgres.DATABASE_URL}}`) — set that up now under the `app` service's
   **Variables** tab.

> Collected: `PUBLIC_BASE_URL`, `DATABASE_URL` (as a service reference).

## 2. Slack — create the app from the manifest (~5 min)

1. Open [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) and replace every
   `YOUR-APP.up.railway.app` with the domain from step 1.4 (four occurrences:
   three slash commands + interactivity).
2. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From a manifest** → pick the Dr. Claw Development workspace → paste the
   manifest (YAML tab) → **Create**.
3. On the app page: **Install App** → **Install to Workspace** → allow.
   - Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
4. **Basic Information** → **App Credentials** → copy the **Signing Secret**
   → `SLACK_SIGNING_SECRET`.
5. Get the two Slack IDs the app needs:
   - **Marketer user ID** (`MARKETER_SLACK_IDS`): in Slack, open the marketer's
     profile → ⋮ → **Copy member ID** (looks like `U0123ABCDEF`).
   - **Advocacy channel IDs** (`ADVOCACY_CHANNEL_ID`): comma-separated channel IDs
     where post cards are broadcast. For each channel, open it → click its name →
     scroll the About tab to the bottom — the `C…` ID is there. Separate multiple
     with commas (e.g., `C0123ABCDEF,C0456DEFGHI`).
6. Slack will warn that the request URLs aren't verified yet — that's expected;
   nothing is deployed. Verification happens in Phase 6 when the server is live.

> Collected: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `MARKETER_SLACK_IDS`,
> `ADVOCACY_CHANNEL_ID`.

## 3. LinkedIn — developer app + product access (~10 min + review wait)

1. Go to [developer.linkedin.com](https://developer.linkedin.com) → **Create app**.
   - App name: `LowEffortLinkedIn` (or anything).
   - LinkedIn page: associate the Dr. Claw Development company page (prerequisite
     above). LinkedIn may ask the page admin to verify the association — do that
     from the email/notification it sends.
   - Logo + legal agreement → create.
2. **Auth** tab:
   - Copy **Client ID** → `LINKEDIN_CLIENT_ID` and **Client Secret**
     → `LINKEDIN_CLIENT_SECRET`.
   - Under **OAuth 2.0 settings** → **Authorized redirect URLs for your app**, add
     exactly:
     `https://<your-railway-domain>/auth/linkedin/callback`
     This string must byte-for-byte match `LINKEDIN_REDIRECT_URI`.
3. **Products** tab — request both:
   - **Sign In with LinkedIn using OpenID Connect** (gives `openid profile` and the
     `/v2/userinfo` endpoint).
   - **Share on LinkedIn** (gives `w_member_social` — posting on the member's
     behalf).
   Both are self-serve products and are usually granted within minutes; you'll see
   them move from "Requested" to "Added" on the same tab. If either sits in review
   longer, everything else still proceeds — the app runs in mock mode until then.
4. While waiting: keep `LINKEDIN_MOCK_MODE=true`. Flip it to `false` only after
   both products show as added **and** Phase 6 smoke-testing starts.

> Collected: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
> `LINKEDIN_REDIRECT_URI`.

## 4. Generate the app's own secrets (~1 min)

Run each of these twice locally and keep the outputs separate:

```sh
openssl rand -base64 32   # → OAUTH_STATE_SECRET
openssl rand -base64 32   # → TOKEN_ENCRYPTION_KEY
```

Don't reuse one value for both, and generate different ones for local dev vs
production.

## 5. Put it all in Railway

On the `app` service → **Variables** tab, add every variable from
[`.env.example`](../.env.example) with the values collected above, plus:

- `LINKEDIN_MOCK_MODE=true`
- `NODE_ENV=production`
- (`PORT` is injected by Railway automatically; the app reads it.)

## Done — Phase 0 exit criteria

- [ ] Railway project with Postgres + `app` service, public domain generated
- [ ] Slack app installed to the workspace; bot token + signing secret captured
- [ ] Marketer user ID + advocacy channel ID captured
- [ ] LinkedIn app created, redirect URL registered, both products requested
      (ideally already granted)
- [ ] All variables set on the Railway `app` service
- [ ] Secrets generated fresh, nothing committed to the repo

Phase 1 (project scaffold, server, migrations) can start immediately — it only
needs the repo. The Slack URL verification and LinkedIn live test come with the
deploy, below.

---

## 6. Deploy (plan Phase 7, ~10 min)

The repo ships a `Dockerfile` and `railway.json` — Railway picks both up
automatically. Migrations run at container start (`knex migrate:latest` is
idempotent), so there's no separate release step.

1. On the Railway `app` service → **Settings** → **Source** → connect this
   GitHub repo, branch `main`. Every merge to `main` now deploys.
2. First deploy: watch the build logs, then hit
   `https://<your-domain>/healthz` — you want `{"status":"ok","db":"up"}`.
   A `db: "down"` means `DATABASE_URL` isn't set or doesn't point at the
   Postgres service.
3. Verify the Slack request URL: [api.slack.com/apps](https://api.slack.com/apps)
   → your app → **Interactivity & Shortcuts** → re-save the (already-correct)
   request URL — Slack pings the live endpoint and should show a green
   "Verified". Do the same check under **Slash Commands** if prompted.
4. LinkedIn: confirm the redirect URL on the app's **Auth** tab matches
   `https://<your-domain>/auth/linkedin/callback` exactly.
5. Smoke test in Slack, still in mock mode (`LINKEDIN_MOCK_MODE=true` — shares
   are simulated, nothing posts to LinkedIn):
   - `/create-post` as the marketer → card appears with buttons + `✅ 0 shares`.
   - Click a Share button → connect prompt → complete the (mocked) connect flow
     → share succeeds, counter ticks to 1.
   - `/advocacy-stats` and `/disconnect` respond.
6. Go live: once both LinkedIn products show **Added**, set
   `LINKEDIN_MOCK_MODE=false` on the Railway service (it redeploys), reconnect
   with a real LinkedIn account, and run the full manual QA checklist in
   [PLAN.md §12](PLAN.md#12-testing-strategy) — starting with sharing a real
   post to a test profile.

## Done — deploy exit criteria

- [ ] `main` connected to Railway; deploys green; `/healthz` reports `db: up`
- [ ] Slack request URL verified against the live server
- [ ] Mock-mode smoke test passed end to end in the real workspace
- [ ] `LINKEDIN_MOCK_MODE=false` flipped after product approval; a real share
      landed on a test LinkedIn profile

---

## 7. Optional: admin config UI (`/admin`)

Lets a marketer manage a subset of the variables above at `https://<your-domain>/admin`
instead of via Railway's dashboard — see `plans/env-var-ui-feature-spec.md` for
what's in scope and why some variables (like `DATABASE_URL` and
`MARKETER_SLACK_IDS` itself) are deliberately Railway-only.

1. On the Slack app page → **OAuth & Permissions** → find the **"Sign in with
   Slack"** (OpenID Connect) section → note the **Client ID** / **Client
   Secret** shown there (these are separate from the bot token above).
2. Add the redirect URL `https://<your-domain>/admin/login/callback` to that
   section's allow-list.
3. On Railway, set:
   - `ADMIN_UI_ENABLED=true`
   - `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` from step 1
   - `ADMIN_SESSION_SECRET` — generate with `openssl rand -base64 32`
     (don't reuse `OAUTH_STATE_SECRET`)
4. Visit `/admin`, sign in with a Slack account whose ID is in
   `MARKETER_SLACK_IDS`.
