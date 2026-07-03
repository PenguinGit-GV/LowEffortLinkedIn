# Feature Spec: Environment Variables Admin UI

Builds on `plans/roadmap.md` (scope/phases) and `plans/apple-design.md` (visual
design). This document nails down the concrete architecture, data model, API
contracts, and phase-by-phase build plan against the actual codebase.

## Decisions Locked In

- **Variable scope**: manage non-bootstrap vars only. Vars needed to reach or
  decrypt the database stay Railway-only (see Allow-List below).
- **Admin auth**: "Sign in with Slack" (OpenID Connect), gated on
  `MARKETER_SLACK_IDS`, using a signed session cookie — no new sessions table.
- **Build scope**: all 4 roadmap phases, shipped as separate PRs.
- **Frontend**: server-rendered HTML + vanilla JS, extending the existing
  `src/pages.js` pattern. No new frontend dependencies.

## Variable Allow-List

The bootstrap problem: `DATABASE_URL` and `TOKEN_ENCRYPTION_KEY` can't live in
a DB row that requires them to read. `OAUTH_STATE_SECRET` and
`SLACK_SIGNING_SECRET` gate the flows that let a user reach the app at all.
The new `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` (Phase 1, added for admin
login) gate the *admin UI itself* — same class of problem, one level up.

| Variable | Manageable? | Sensitive? | Hot-reload? | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | ❌ Railway only | — | — | Bootstrap |
| `TOKEN_ENCRYPTION_KEY` | ❌ Railway only | — | — | Bootstrap |
| `OAUTH_STATE_SECRET` | ❌ Railway only | — | — | Gates connect-link/state tokens |
| `SLACK_SIGNING_SECRET` | ❌ Railway only | — | — | Gates all Slack request verification |
| `SLACK_BOT_TOKEN` | ❌ Railway only | — | — | Needed to boot the Bolt client |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` (new) | ❌ Railway only | — | — | Gates admin login itself |
| `MARKETER_SLACK_IDS` | ❌ Railway only (F1) | — | — | Controls who can access the UI; self-service editing is a lockout/privilege-escalation risk |
| `ADVOCACY_CHANNEL_ID` | ✅ | No | Yes | |
| `LINKEDIN_CLIENT_ID` | ✅ | Yes | Yes | |
| `LINKEDIN_CLIENT_SECRET` | ✅ | Yes | Yes | |
| `LINKEDIN_REDIRECT_URI` | ✅ | No | Yes | Must match LinkedIn app config |
| `LINKEDIN_MOCK_MODE` | ✅ | No | No (restart) | Flips real vs mock client construction |
| `LINKEDIN_API_VERSION` | ✅ | No | Yes | |
| `REMINDER_CRON` | ✅ | No | Special (see F2) | Requires job restop/restart, not a config mutation |
| `POST_EXPIRY_CRON` | ✅ | No | Special (see F2) | Same as above |
| `DEFAULT_POST_EXPIRY_HOURS` | ✅ | No | Yes | |
| `PUBLIC_BASE_URL` | ✅ | No | Yes | Used to build redirect/callback URLs |
| `PORT` | ❌ Railway only | — | — | Can't rebind a listening socket at runtime |
| `NODE_ENV` | ❌ Railway only | — | — | Low value, high blast radius |

## Data Model

```js
// Migration: create_admin_config
await knex.schema.createTable('config_overrides', (t) => {
  t.text('key').primary(); // must be in the server-side allow-list
  t.text('value'); // AES-256-GCM encrypted (reuses TOKEN_ENCRYPTION_KEY) if sensitive, else plaintext
  t.boolean('is_sensitive').notNullable();
  t.text('updated_by').notNullable(); // slack_user_id
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
});

await knex.schema.createTable('config_audit', (t) => {
  t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
  t.text('key').notNullable();
  t.text('action').notNullable(); // 'set' | 'reset'
  // Sensitive keys: redacted() summary only, never ciphertext or plaintext.
  t.text('old_value_display');
  t.text('new_value_display');
  t.text('changed_by').notNullable(); // slack_user_id
  t.timestamp('changed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
});
await knex.raw(`ALTER TABLE config_audit ADD CONSTRAINT config_audit_action_check CHECK (action IN ('set','reset'))`);
await knex.raw(`CREATE INDEX idx_config_audit_key ON config_audit(key)`);
await knex.raw(`CREATE INDEX idx_config_audit_changed_at ON config_audit(changed_at DESC)`);
```

`config_overrides` holds only values that differ from the Railway env default;
deleting a row resets that key to its env value. A live `effectiveConfig()`
helper merges `loadConfig(process.env)` with any DB overrides at read time.

## Admin Auth: Sign in with Slack

New env vars (Railway-only, added to the bootstrap set): `SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET`, `ADMIN_SESSION_SECRET` (dedicated signing key —
deliberately not reusing `OAUTH_STATE_SECRET`, so rotating one doesn't log out
admins or invalidate in-flight LinkedIn connect links).

- `GET /admin/login` → redirect to `https://slack.com/openid/connect/authorize`
  with `client_id`, `scope=openid`, and a signed CSRF `state` (via the existing
  `signToken`/`verifyToken` helpers, `purpose: 'admin_state'`, 10 min TTL).
- `GET /admin/login/callback` → verify state, exchange `code` via
  `openid.connect.token`, call `openid.connect.userInfo`, extract the Slack
  user ID, reject if not in `config.marketerSlackIds`, then set a signed
  session cookie (`signToken({ slack_user_id, purpose: 'admin_session' },
  ADMIN_SESSION_SECRET, 12h)`) as `HttpOnly; Secure; SameSite=Strict`.
- `POST /admin/logout` → clears the cookie.
- `requireAdminSession` middleware: verifies the cookie on every `/admin/*`
  route except `/admin/login*`; 401 → redirect to `/admin/login`.
- CSRF: `SameSite=Strict` cookies plus requiring `Content-Type:
  application/json` on all mutating requests (cross-site HTML forms can't set
  either) — no separate CSRF token needed for a JSON-only API surface.

## API Surface (all under `/admin`, behind `requireAdminSession`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | Serves the dashboard HTML shell |
| GET | `/admin/api/config` | List allow-listed vars: key, effective value (masked if sensitive), source (`env`/`override`), `is_sensitive`, `hot_reload` kind, `updated_at`, `updated_by` |
| PUT | `/admin/api/config/:key` | Validate key ∈ allow-list + type/format checks, upsert override, write audit row, apply reload strategy |
| DELETE | `/admin/api/config/:key` | Remove override (reset to env default), write audit row |
| GET | `/admin/api/audit?key=&page=` | Paginated audit log |
| GET | `/admin/api/health` | DB / Slack / LinkedIn connectivity (Phase 3) |
| POST | `/admin/api/restart` | Graceful self-restart (Phase 3) |
| GET | `/admin/api/backup` | Export current overrides as JSON (Phase 4) |
| POST | `/admin/api/restore` | Import + diff-preview before apply (Phase 4) |

Per-key server-side validators (reuse existing logic, don't duplicate it):
`REMINDER_CRON`/`POST_EXPIRY_CRON` via `node-cron.validate()`;
`DEFAULT_POST_EXPIRY_HOURS` via the same bounds check as `config.js`;
`LINKEDIN_MOCK_MODE` as a strict boolean; URLs via `new URL()`.

## Hot-Reload Mechanics

The original roadmap's "reload the config module" doesn't hold up:
`config` is a plain object created once in `index.js` and passed by reference
into `server.js`, handlers, and job starters. Two different mechanisms are
actually needed:

1. **In-place mutation** (`ADVOCACY_CHANNEL_ID`, `LINKEDIN_*`,
   `DEFAULT_POST_EXPIRY_HOURS`, `PUBLIC_BASE_URL`): safe because every call
   site reads `config.foo` fresh at request time. Writing
   `Object.assign(config, effectiveConfig())` after a DB write is sufficient.
2. **Job restop** (`REMINDER_CRON`, `POST_EXPIRY_CRON`): `startExpiryReminderJob`
   / `startPostExpiryJob` capture the cron string once, at `cronLib.schedule()`
   call time. Mutating `config.reminderCron` afterward does **not** reschedule
   anything already running. Changing one of these must call `.stop()` on the
   existing task and re-invoke the corresponding `start*Job` function with the
   refreshed config, swapping the in-memory task handle the shutdown hook in
   `index.js` closes over.
3. **Restart-required** (`LINKEDIN_MOCK_MODE`): the mock vs. real LinkedIn
   client is constructed once in `index.js`/`server.js`
   (`createShareClient(config)`); changing this mid-process would leave stale
   closures. Flagged `requires_restart: true` in the API response; the UI
   disables hot-apply and requires the Phase 3 restart flow.

## Build Plan (4 PRs, one per phase)

### PR 1 — Phase 1: Foundation
- Migration for `config_overrides` + `config_audit`
- `src/config/overrides.js`: `effectiveConfig(config, db)`, `applyOverride()`, `resetOverride()`
- `src/admin/auth.js`: Sign-in-with-Slack routes + `requireAdminSession` middleware
- `src/admin/api.js`: the 4 core endpoints (list/set/delete/audit), server-side allow-list + validators
- New env vars documented in `.env.example`: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `ADMIN_SESSION_SECRET`
- Tests: allow-list enforcement, validator rejection cases, session middleware, audit redaction of sensitive values

### PR 2 — Phase 2: Frontend
- `src/admin/pages.js`: dashboard HTML (extends the `pages.js` pattern), styled per `plans/apple-design.md`
- Vanilla JS: fetch-based form submission, confirm dialog, sensitive-var masking/badges, audit log table
- Tests: HTML escaping of user/config values (XSS surface, unlike the static pages in `pages.js` today)

### PR 3 — Phase 3: Smart Reload
- In-place mutation path wired into `PUT /admin/api/config/:key`
- Cron job restop path for `REMINDER_CRON`/`POST_EXPIRY_CRON`, with the task handles made swappable (currently `const` in `index.js`)
- `/admin/api/health` (DB/Slack/LinkedIn probes)
- `/admin/api/restart`: calls `process.exit(0)` after draining, relies on Railway's restart policy — **not a zero-downtime operation**; see Finding F3
- Tests: mutation takes effect without restart; cron restop reschedules correctly; restart-required vars are rejected by hot-apply

### PR 4 — Phase 4: Multi-Environment / Backup / Collaboration
- Scope down 4.1 (see Finding F4) or defer per your call below
- `/admin/api/backup` + `/admin/api/restore` with diff preview
- Scheduled daily snapshot to `config_audit` or a dedicated `config_snapshots` table
- Edit locking: short-lived "key locked by X" row/flag to prevent two admins writing the same key concurrently; no real-time push (no websocket infra exists) — poll on save conflict instead
- Tests: restore diff correctness, concurrent-edit lock rejection

## Two-Pass Review

### Pass 1 — Issues Found

1. **F1 — `MARKETER_SLACK_IDS` self-service is a privilege-escalation / lockout risk.** It's on the "manageable" list in the original roadmap, but it controls who can reach the admin UI at all. A compromised or careless admin could add arbitrary Slack IDs, or remove every ID but their own (or all of them, locking everyone out including Railway-console recovery unless they redeploy). Roadmap doesn't address this.
2. **F2 — Cron var hot-reload as originally scoped ("auto-reload config module... no-op if unreferenced") doesn't work.** `REMINDER_CRON`/`POST_EXPIRY_CRON` are captured once at `cronLib.schedule()` time in job-start functions; mutating a shared config object doesn't reschedule a running node-cron task. Needs explicit stop/restart of the task.
3. **F3 — "Graceful restart" (Phase 3.2) has no zero-downtime story.** Single Railway service instance; `process.exit()` + platform auto-restart means a real (if brief) outage window while the container relaunches. The original roadmap implies a clean toggle; it isn't one.
4. **F4 — Phase 4.1 (multi-environment switching) is likely not implementable as scoped.** Switching to another Railway environment from a running instance requires that environment's `DATABASE_URL` (and likely its `TOKEN_ENCRYPTION_KEY`) to be available *somewhere* — which reintroduces the exact bootstrap-secret problem F1's variable allow-list exists to avoid. As scoped, this phase either needs those secrets stored (defeating the purpose) or doesn't actually work.
5. **F5 — Audit log storing "old/new value" verbatim risks leaking secrets even for non-sensitive-looking vars.** E.g. `PUBLIC_BASE_URL` looks harmless, but a mistakenly-pasted secret into any text field would land in `config_audit` in plaintext forever. Need a redaction strategy that isn't purely keyed on the `is_sensitive` flag.
6. **F6 — CSRF story needs to be explicit, not assumed.** A cookie-based admin session on state-changing endpoints is a classic CSRF target if not deliberately mitigated.
7. **F7 — No mention of what happens to `config_overrides` if `TOKEN_ENCRYPTION_KEY` is rotated on Railway.** Existing sensitive overrides become undecryptable (same failure class the app already has for `users.linkedin_access_token`, but worth stating so it isn't "discovered" during an incident).
8. **F8 — New admin surface adds `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` as new bootstrap secrets**, which the original ask ("manage vars instead of via Railway") doesn't reduce — it's an unavoidable consequence of adding real login, not a flaw, but should be stated so it's not a surprise that Railway dependency isn't fully eliminated.

### Pass 2 — Critique of Findings

- F1: **Confirmed.** Concrete failure scenario (self-lockout or privilege escalation), not speculative — the roadmap literally lists this var as manageable with no caveat.
- F2: **Confirmed.** Verified directly against `src/jobs/expiryReminder.js`/`postExpiry.js` — `cronLib.schedule(config.reminderCron, ...)` runs once at job-start; there is no re-read of `config.reminderCron` afterward.
- F3: **Confirmed, but downgrade severity.** This is a reasonable and disclosed limitation of a single-instance Railway deployment, not a bug — the fix is to document it clearly in the UI ("this will briefly interrupt service"), not to solve zero-downtime restart (out of scope for this app's size).
- F4: **Confirmed as a real feasibility gap**, not just a nice-to-have caveat. Recommend descoping to something achievable: read-only display of *which* environment the current instance is running against (from `RAILWAY_ENVIRONMENT_NAME` or similar), not live switching.
- F5: **Confirmed**, and generalizable — rather than trusting a per-key `is_sensitive` flag alone, apply a lightweight heuristic redaction (regex for token/key/secret-shaped values) as defense in depth on top of the allow-list's static classification.
- F6: **Confirmed** but the fix is cheap (SameSite=Strict + JSON content-type requirement, already folded into the plan above) — not a separate large effort.
- F7: **Plausible but low-impact** — this is a pre-existing class of risk the app already accepts for user tokens; documenting it costs nothing, but building recovery tooling for it is speculative work with no concrete trigger. Recommend: document only, don't build tooling.
- F8: **Not a defect** — removed as a finding; it's an accurate scope note already captured in the "Decisions Locked In" section, not a new issue to fix.

## Recommendation

**Fix now (blocking, cheap, and load-bearing for correctness/security):**
F1, F2, F5, F6

**Fix now (scope correction, prevents building something that doesn't work):**
F4 (descope multi-environment switching to a read-only environment-name display)

**Document only, no code change:**
F3 (disclose the outage window in the UI copy), F7 (note in README/docs)

**Not an issue:** F8

## Decision

**Confirmed: fix all confirmed issues (F1, F2, F4, F5, F6 as code changes; F3, F7 as documentation).**
F3 and F7 are explicitly deferred — no restart-orchestration or key-rotation-recovery tooling is built in this pass.

## Delivery Plan

Shipped as 4 stacked PRs, each building on the previous:
1. `claude/admin-ui-phase1-foundation` — schema, allow-list, Slack OIDC admin auth, core API
2. `claude/admin-ui-phase2-frontend` — Apple-styled dashboard UI
3. `claude/admin-ui-phase3-reload` — hot-reload mechanics, health check, restart
4. `claude/admin-ui-phase4-backup` — backup/restore, audit-based snapshots, edit locking; multi-environment descoped to a read-only current-environment label per F4
