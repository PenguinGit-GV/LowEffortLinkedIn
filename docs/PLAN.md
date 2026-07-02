# LowEffortLinkedIn — Feature Request & Implementation Plan

Slack-native employee advocacy app: a marketer broadcasts LinkedIn-ready posts into
a Slack channel; employees connect LinkedIn once via OAuth, then share pre-written
or custom captions to their own LinkedIn profile with one click.

This document is the detailed spec + implementation plan produced from stakeholder
Q&A. It supersedes the original one-page brief — where this doc adds detail or
changes something from that brief, this doc wins.

## 1. Decisions Log

Choices locked in during planning, and why. Anything not listed here was decided by
the author as a reasonable default and called out inline where it matters.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Backend stack | Node.js + `@slack/bolt` (`ExpressReceiver`) | Native Slack SDK, first-class Block Kit/modal support, and `ExpressReceiver` lets us bolt custom HTTP routes (LinkedIn OAuth) onto the same Express app as the Slack routes. |
| 2 | Database | PostgreSQL from day one | Avoids the SQLite-on-ephemeral-filesystem trap; no migration needed later. |
| 3 | Hosting | Railway | Managed Postgres, HTTPS by default, simple env var config, built-in cron for the token-expiry job. |
| 4 | LinkedIn API access | Not yet approved | Plan includes a Phase 0 application step and a `LINKEDIN_MOCK_MODE` so backend work isn't blocked on LinkedIn's review process. |
| 5 | Marketer authorization | Configurable allowlist (`MARKETER_SLACK_IDS` env var, comma-separated) | Matches "single marketer" today, costs nothing to extend to a few people later. |
| 6 | Schema | Added a third table, `shares`, beyond the spec's `users`/`posts` | Without a share-event log there's no way to audit what went out, build a leaderboard, debounce double-clicks, or debug a failed post. |
| 7 | Token expiry handling | Proactive Slack reminder ~7 days before `token_expires_at` | LinkedIn tokens aren't refreshable in this flow; without a reminder, the Share button just silently breaks after 60 days. |
| 8 | This task's deliverable | This plan document only — no application code yet | Matches the branch intent; implementation begins once this plan is reviewed. |

Two things worth flagging explicitly rather than silently resolving — see [§14 Open
Questions](#14-open-questions-for-follow-up).

## 2. Feature Requirements

### 2.1 Feature 1 — Marketer Engine (`/create-post`)

**Trigger & authorization**
- Slash command `/create-post`, registered on the Slack app.
- On invocation, check `command.user_id` against `MARKETER_SLACK_IDS`. If not
  authorized: ephemeral `"You're not authorized to create posts."` and stop (no DB
  write, no modal).

**Modal (Block Kit view)**
- Destination URL — `plain_text_input`, required.
- Caption A — multiline `plain_text_input`, required, capped at 3000 chars (LinkedIn's
  `commentary` field limit).
- Caption B — multiline, optional.
- Caption C — multiline, optional.
- Server-side validation on submit: URL parses (`new URL()`), Caption A non-empty and
  under the char cap. Invalid input returns a `response_action: errors` pointing at
  the offending block instead of a generic failure.

**Submission handling**
- `view_submission` → `INSERT INTO posts (...) RETURNING id`.
- Post a Block Kit card to `ADVOCACY_CHANNEL_ID` (configurable — see §14.1 on the
  original spec's hardcoded `#sales`):
  - A text block containing the raw destination URL so Slack's native unfurl renders
    the link preview.
  - Section blocks for each non-empty caption variation.
  - An actions block with buttons generated dynamically: `Share Variation A` always,
    `Share Variation B`/`Share Variation C` only if that caption was filled in, and
    `Edit & Share Custom` always. Each button's `value` encodes `{post_id, variation}`.
  - A context block: `Posted by @<marketer> · <date>`.
- Confirm back to the marketer (ephemeral or DM): `"Your post is live in #<channel>."`

**Edge cases**
- Bot not in target channel: request `chat:write.public` so posting to public
  channels doesn't require an invite; surface `channel_not_found`/`not_in_channel`
  as a clear ephemeral error rather than a silent failure.
- Caption exceeding LinkedIn's limit: caught at modal-submission time, not at
  share time — cheaper to fix and doesn't fail in front of an employee.

### 2.2 Feature 2 — One-Time LinkedIn OAuth Handshake

**Trigger points** for the "connect your LinkedIn" prompt (the spec only describes
the first; the other two are necessary for correctness):
1. No row in `users` for this Slack ID.
2. Row exists but `token_expires_at` is in the past.
3. Row exists and unexpired, but LinkedIn's API returns `401` at share time (token
   revoked by the user on LinkedIn's side) — treat identically to "not connected."

**Handshake**
1. Any trigger above → `chat.postEphemeral` **in the channel where the user clicked**
   (visible only to them). This satisfies the "ephemeral DM" intent from the spec
   without needing `im:write`/`conversations.open` for a real DM channel — simpler,
   same effective privacy.
2. The message contains a Block Kit `url`-type button pointing directly to
   `${PUBLIC_BASE_URL}/auth/linkedin?slack_id=${user_id}` (opens in the user's
   browser, no server round trip needed to build it).
3. `GET /auth/linkedin`: build a signed, short-lived `state`
   (HMAC-SHA256 over `{slack_id, nonce, iat}` using `OAUTH_STATE_SECRET`, ~10 min
   expiry), redirect to LinkedIn's authorization endpoint with
   `scope=openid profile w_member_social`.
4. `GET /auth/linkedin/callback`: verify `state` signature and expiry (reject
   tampered/expired state with a friendly error page — this is the CSRF defense),
   exchange the `code` for an access token, call LinkedIn's OIDC userinfo endpoint
   to get the person's URN id (`sub` claim), encrypt the access token
   (AES-256-GCM, see §5), and `UPSERT` into `users`.
5. Render a static "Success! You can close this tab and return to Slack" page. As a
   bonus over the spec: since the server already knows the `slack_id` at this point,
   also fire a Slack confirmation message proactively so the user doesn't have to
   tab back manually to find out it worked.

### 2.3 Feature 3 — Native Sharing Mechanics

**Post card UI** — see §2.1; buttons are generated per-post based on which captions
are populated.

**Instant share (`Share Variation A/B/C`)**
1. Look up the clicking user's token. Missing/expired → run the connect flow
   (§2.2) and stop.
2. Idempotency guard: a short-lived lock keyed on `(post_id, slack_user_id)` so a
   double-click (or a slow LinkedIn response retried by Slack's 3s ack timeout)
   can't produce two LinkedIn posts. Not in the original spec, but necessary —
   a duplicate post is a visible, embarrassing failure on someone's real profile.
3. Build the LinkedIn Posts API payload (see §4), POST it (or simulate, under
   `LINKEDIN_MOCK_MODE`).
4. Insert a `shares` row recording the outcome.
5. Success → `reactions.add` (✅) on the original card message, or an ephemeral
   confirmation. Failure → ephemeral message with LinkedIn's error surfaced
   verbatim, so the employee (or marketer, later) knows what happened.

**Edit & Share Custom**
- Opens a modal pre-filled with Caption A via `initial_value`, `post_id` carried in
  `private_metadata`.
- Submission runs the same pipeline as instant share, with `variation = 'CUSTOM'`
  and the edited text stored in `shares.custom_text`.

## 3. System Architecture

```
Slack workspace
   │  slash command / block_actions / view_submission (HTTPS, signed)
   ▼
Express app (single process, single port)
 ├─ Bolt ExpressReceiver  → /slack/events   (commands, interactivity, modals)
 ├─ custom routes         → /auth/linkedin, /auth/linkedin/callback
 └─ /healthz
   │                                   │
   ▼                                   ▼
PostgreSQL (Railway)              LinkedIn API
 users / posts / shares           OAuth + Posts API
```

Single Node process, single Express app — Bolt's routes and the LinkedIn OAuth
routes share one HTTP server, so only one public port/domain is needed. A daily
cron job (Railway cron or `node-cron` in-process) runs the token-expiry reminder.

## 4. LinkedIn Integration Details

- **OAuth scopes:** `openid profile w_member_social` (current "Sign In with LinkedIn
  using OpenID Connect" + "Share on LinkedIn" products — the older `r_liteprofile`/
  `r_emailaddress` scopes are deprecated).
- **Token exchange:** `POST https://www.linkedin.com/oauth/v2/accessToken`
- **Identity lookup:** `GET https://api.linkedin.com/v2/userinfo` (OIDC) → `sub`
  claim is the person's URN id, used as `linkedin_person_id`.
- **Posting:** `POST https://api.linkedin.com/rest/posts`, headers include
  `LinkedIn-Version: <YYYYMM>` and `X-Restli-Protocol-Version: 2.0.0`. Representative
  payload (verify exact schema against LinkedIn's live docs once Phase 0 access is
  granted — this is illustrative, not a guarantee of the current contract):

  ```json
  {
    "author": "urn:li:person:{linkedin_person_id}",
    "commentary": "{caption text}",
    "visibility": "PUBLIC",
    "distribution": { "feedDistribution": "MAIN_FEED" },
    "content": { "article": { "source": "{destination_url}" } },
    "lifecycleState": "PUBLISHED",
    "isReshareDisabledByAuthor": false
  }
  ```

  A `201` response's `x-restli-id` header carries the new post's URN, stored in
  `shares.linkedin_post_urn` for traceability.
- **Token lifetime:** `expires_in` (~5,184,000s / 60 days) from the token exchange
  response defines `token_expires_at`. This flow does not use a refresh token —
  expiry is handled by the reminder job (§2.2) plus reactive re-auth on `401`.

## 5. Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  slack_user_id           TEXT PRIMARY KEY,
  linkedin_access_token    TEXT,            -- AES-256-GCM encrypted, base64
  linkedin_person_id       TEXT,
  token_expires_at         TIMESTAMPTZ,
  expiry_reminder_sent_at  TIMESTAMPTZ,      -- added: dedupes the §2.2 reminder job
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_url      TEXT NOT NULL,
  caption_a            TEXT NOT NULL,
  caption_b            TEXT,
  caption_c            TEXT,
  created_by_slack_id  TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added beyond the original 2-table spec — see Decisions Log #6.
CREATE TABLE shares (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             UUID NOT NULL REFERENCES posts(id),
  slack_user_id       TEXT NOT NULL REFERENCES users(slack_user_id),
  variation           TEXT NOT NULL CHECK (variation IN ('A','B','C','CUSTOM')),
  custom_text         TEXT,                 -- set only when variation = 'CUSTOM'
  linkedin_post_urn   TEXT,
  status              TEXT NOT NULL CHECK (status IN ('success','failed')),
  error_message       TEXT,
  shared_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shares_post_id ON shares(post_id);
CREATE INDEX idx_shares_slack_user_id ON shares(slack_user_id);
```

Migrations managed via Knex.js (lightweight query builder + migration runner —
enough structure for a 3-table schema without ORM overhead).

## 6. Slack App Configuration

- **Bot token scopes:** `commands`, `chat:write`, `chat:write.public`,
  `reactions:write`.
- **Slash Commands:** `/create-post` → Request URL `${PUBLIC_BASE_URL}/slack/events`.
- **Interactivity & Shortcuts:** on, same Request URL.
- **Socket Mode:** not used — we already need a public HTTPS endpoint for the
  LinkedIn OAuth callback, so Bolt runs in standard HTTP mode on that same endpoint.
- Single-workspace internal install (bot token + signing secret) — no Slack-side
  OAuth/distribution flow needed, since this isn't a multi-workspace app.

## 7. Environment Variables

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token for the Slack app |
| `SLACK_SIGNING_SECRET` | Verifies incoming Slack requests |
| `MARKETER_SLACK_IDS` | Comma-separated allowlist for `/create-post` |
| `ADVOCACY_CHANNEL_ID` | Channel the post cards are broadcast to |
| `DATABASE_URL` | Postgres connection string (Railway-provided) |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn app credentials |
| `LINKEDIN_REDIRECT_URI` | Must exactly match the LinkedIn app's registered redirect |
| `OAUTH_STATE_SECRET` | HMAC key for signing the OAuth `state` param |
| `TOKEN_ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM token encryption at rest |
| `PUBLIC_BASE_URL` | This server's public HTTPS origin |
| `LINKEDIN_MOCK_MODE` | `true` until LinkedIn API access is approved (§9, Phase 0) |
| `PORT`, `NODE_ENV` | Standard server config |

## 8. Security & Edge Cases

- OAuth `state` is signed and short-lived — defends the callback route against CSRF
  and replay.
- LinkedIn access tokens are encrypted at rest (AES-256-GCM); the encryption key
  lives only in env config, never logged, never committed.
- Marketer authorization is enforced server-side on every `/create-post` invocation,
  not just hidden from the Slack UI.
- Slack request signatures are verified by Bolt automatically via
  `SLACK_SIGNING_SECRET`.
- Share actions are debounced per `(post_id, slack_user_id)` to prevent duplicate
  LinkedIn posts from double-clicks.
- Raw tokens and full LinkedIn payloads are never logged.
- Server fails fast at startup if `MARKETER_SLACK_IDS` is empty/unset, rather than
  silently locking everyone out or (worse) leaving the command unrestricted.

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| LinkedIn API access delayed or denied | Core share feature blocked | Apply in Phase 0 immediately; all other phases build/test against `LINKEDIN_MOCK_MODE` in parallel; fallback UX (copy caption + open LinkedIn's `sharing/share-offsite` web intent) if API access is never granted |
| LinkedIn API schema differs from §4's representative payload | Integration breaks on first real attempt | Verify exact request/response contract against LinkedIn's live docs at Phase 3 kickoff |
| Double-click produces duplicate LinkedIn posts | Visible, embarrassing duplicate content on an employee's real profile | Idempotency guard, §2.3 |
| DB breach exposes LinkedIn tokens | Employees' accounts could be posted to without consent | Encryption at rest, key isolation, restricted DB network access |
| `MARKETER_SLACK_IDS` misconfigured | Wrong people (or nobody) can broadcast company content | Fail-fast startup check |
| LinkedIn per-member rate limits | Shares silently fail during a high-traffic campaign | Surface LinkedIn's error verbatim in the ephemeral failure message |

## 10. Phased Implementation Plan

**Phase 0 — Foundations (non-code, can run in parallel with Phase 1–2)**
- Apply for LinkedIn Developer App access: "Sign In with LinkedIn using OpenID
  Connect" + "Share on LinkedIn" products.
- Create the Slack app from a manifest, install to the workspace, capture bot
  token + signing secret.
- Provision Railway project + Postgres, capture `DATABASE_URL`.

**Phase 1 — Project Scaffold, Server, Schema**
- Init Node project; `@slack/bolt`, `express`, `pg`, `knex`, `axios`, `dotenv`,
  `node-cron`.
- `ExpressReceiver`-based Bolt app so custom routes share the same server.
- Knex migrations for `users` / `posts` / `shares`.
- `/healthz` route; local dev tunnel documented (ngrok or Slack CLI).

**Phase 2 — `/create-post` Flow**
- Slash command handler with marketer allowlist check.
- Modal open + `view_submission` handler: validate, insert into `posts`, post the
  Block Kit card to `ADVOCACY_CHANNEL_ID`.

**Phase 3 — LinkedIn OAuth Pipeline**
- `/auth/linkedin` (signed state, redirect) and `/auth/linkedin/callback` (verify,
  exchange, encrypt, upsert) routes.
- Connect-prompt ephemeral message + button wired to all three trigger points
  from §2.2.

**Phase 4 — Share Interactivity + Posting**
- `block_actions` handlers for `share_variation_a/b/c`: token check → idempotency
  guard → LinkedIn POST (real or mocked) → `shares` insert → success/failure
  feedback.
- `Edit & Share Custom` modal (pre-filled) and its `view_submission` handler,
  reusing the same posting pipeline.

**Phase 5 — Token Expiry Reminder**
- Daily job: query `users` where `token_expires_at` is within 7 days and
  `expiry_reminder_sent_at` hasn't already covered this window; DM a reconnect
  button; stamp `expiry_reminder_sent_at`.

**Phase 6 — Deploy**
- Dockerfile/nixpacks build on Railway; configure env vars.
- Point the Slack app's Request URL and the LinkedIn app's redirect URI at the
  Railway public domain.
- End-to-end smoke test in the real workspace with a real LinkedIn test account.

**Phase 7 — Deferred** (see §13)

## 11. Testing Strategy

- **Unit (Jest):** state param sign/verify (valid, tampered, expired); token
  encrypt/decrypt round-trip; LinkedIn payload builder; marketer-allowlist check.
- **Route-level (supertest):** `/auth/linkedin` redirect status + `Location` header;
  `/healthz`.
- **Manual QA checklist** (full Slack+LinkedIn e2e needs live accounts, not
  automatable cheaply):
  1. `/create-post` → card appears with the right buttons for the captions filled in.
  2. Connect flow end-to-end with a real personal LinkedIn test account.
  3. `Share Variation A` → post appears on LinkedIn; ✅ reaction appears in Slack.
  4. Click Share while disconnected → connect prompt appears.
  5. `Edit & Share Custom` → edited text is what's posted.
  6. Rapid double-click on Share → only one LinkedIn post is created.
  7. Force an expired `token_expires_at` → reminder DM fires.

## 12. Out of Scope / Future Enhancements

- Leaderboard/analytics surfaced in Slack (the `shares` table makes this possible
  later without a schema change).
- Multi-channel broadcast for a single post.
- Editing/deleting/expiring a post after it's been broadcast.
- Image/media attachments on LinkedIn posts (MVP is link-only).
- Multi-workspace distribution.
- Posting to LinkedIn Company Pages (`w_organization_social` — a different,
  harder-to-get product from the personal-profile `w_member_social` this plan uses).

## 13. Open Questions for Follow-up

1. **Share Variation C button:** the original brief's Post Card UI section lists
   only `Share Variation A`, `Share Variation B`, and `Edit & Share Custom` — it
   never mentions a third share button, even though the modal and schema both
   capture Caption C. This plan defaults to rendering a `Share Variation C` button
   whenever `caption_c` is filled in (§2.1). Flag if Caption C was meant for
   something else.
2. **Copy/tone:** exact wording for the connect prompt, DMs, and the OAuth success
   page isn't specified anywhere. Draft copy will be proposed during Phase 2–3 for
   review, not treated as final.
3. **Marketer visibility into share activity:** should the marketer get a rollup
   ("12 people shared this so far") in-channel or via DM? Currently deferred to
   §12 Future Enhancements — say so if you want it pulled into the MVP.
