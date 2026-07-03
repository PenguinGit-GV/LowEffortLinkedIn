# Environment Variables UI Backend - Roadmap

## Overview

Build a web-based UI backend to manage environment variables directly in the application instead of relying on Railway's dashboard. This provides:
- Self-hosted secret management without external platform dependency
- Real-time environment variable updates without redeployment
- Audit trail of configuration changes
- Simplified onboarding for team members
- Escape hatch if Railway discontinues or changes pricing

## Phase 1: Foundation (Weeks 1-2)

### 1.1 API Endpoints
- `GET /admin/config` - List all environment variables (non-sensitive metadata only)
- `POST /admin/config/:key` - Create/update a single environment variable
- `DELETE /admin/config/:key` - Remove an environment variable
- `GET /admin/config/audit` - View change history with timestamps and actor

### 1.2 Database Schema
- `config_vars` table: `(key, value, updated_at, updated_by)`
- `config_audit` table: `(key, action, old_value, new_value, updated_at, updated_by, reason)`
- Store encrypted values in DB; only decrypt on read

### 1.3 Authentication & Authorization
- Require Slack admin verification (only `MARKETER_SLACK_IDS` can access)
- Middleware to check Slack user ID from OAuth context
- Rate limiting on write operations (5 req/min per user)

## Phase 2: Frontend (Weeks 3-4)

### 2.1 Simple Web Form
- Read-only view of all current env vars (masked sensitive keys)
- Form inputs for each editable variable
- Confirm dialog before applying changes
- Success/error notifications

### 2.2 Security Indicators
- Show which variables are considered "sensitive" (TOKEN, SECRET, KEY, PASSWORD)
- Visual hint that changing certain vars may require app restart
- Clear labeling of PostgreSQL vs Slack vs LinkedIn credentials

### 2.3 Audit Log UI
- Sortable table of recent changes
- Filter by key, date range, user
- Show before/after values (redacted for sensitive vars)

## Phase 3: Smart Reload (Weeks 5-6)

### 3.1 Dynamic Reloading
- Auto-reload `config` module on safe-to-change vars (REMINDER_CRON, POST_EXPIRY_CRON, etc.)
- No-op if the var isn't actually referenced at runtime
- Unsafe vars (DB_URL, OAUTH secrets) flag as "requires restart" and disable in UI

### 3.2 Service Restart
- Button to gracefully restart the bot (stop cron jobs, close DB, exit)
- PM2 or systemd auto-restart will pick up new env vars
- Lock the UI during restart with countdown

### 3.3 Health Check
- Endpoint to report whether DB, Slack, and LinkedIn connections are alive
- Show in dashboard post-restart
- Alert if a connection fails after applying a config change

## Phase 4: Multi-Environment (Weeks 7+)

### 4.1 Staging/Production Toggle (Optional)
- If running multiple Railway envs, allow switching between them
- Show which environment is currently active
- Warn before modifying production

### 4.2 Backup & Restore
- Export current config as JSON (encrypted in DB)
- Import from backup (with diffs before apply)
- Scheduled daily snapshots to DB

### 4.3 Team Collaboration
- Real-time notifications when another user modifies config
- Edit locking to prevent simultaneous changes
- Approval workflow for critical variables (optional)

## Technical Implementation Details

### Storage
- Use existing PostgreSQL (create migration for new tables)
- Encrypt sensitive values with existing `TOKEN_ENCRYPTION_KEY`
- Keep plaintext keys (non-sensitive) for UI filtering

### Frontend Stack
- Lightweight: HTML form + fetch API, or simple React/Vue if repo already uses it
- Serve from same Express app as bot
- No external CDNs (self-hosted assets only)

### Config Hot-Reload Strategy
```
1. Write to DB with transaction
2. POST to internal /admin/config/reload endpoint
3. In-process: shallow reload only `config` module
4. For vars that can't reload: flag UI as "requires manual restart"
5. Log change to audit table
```

### Encryption Pattern
```javascript
// On write
const encrypted = encrypt(value, TOKEN_ENCRYPTION_KEY);
await db('config_vars').insert({ key, value: encrypted, ... });

// On read (API)
const { value } = await db('config_vars').where({ key });
const decrypted = decrypt(value, TOKEN_ENCRYPTION_KEY);
return decrypted;

// On read (UI form)
// Never send plaintext to frontend; UI shows ***masked*** or summary only
```

## Success Criteria

- [ ] All current env vars can be viewed and edited via UI
- [ ] Changes persist across app restarts
- [ ] Slack admin verification prevents unauthorized access
- [ ] Audit log tracks who changed what and when
- [ ] Sensitive values are never logged or exposed in audit
- [ ] Cron job schedule changes work without redeployment
- [ ] Zero new external dependencies (use what's already in package.json)
- [ ] API documented in README or inline

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Accidental deletion of critical var | Audit log + snapshots; require restart for critical changes |
| Unauthorized access to secrets | Slack OAuth verification + rate limiting |
| Database outage loses config | Backup to JSON file; restore from Railway secrets as fallback |
| Hot-reload breaks application | Only reload safe vars; flag others as restart-required |
| Config not updated after button click | Health check endpoint post-change; show clear status |

## Post-Launch Refinements

- Add variable templates (LinkedIn version, reminder window, etc.)
- Suggest "safe to change now" vars based on time-of-day
- Slack notifications on every config change (with @mentions for sensitive vars)
- Bulk import from Railway export (one-time CSV/JSON migration tool)
