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

### 2.1 Apple Design System
The UI follows Apple's design principles — photography-first (in this case, data-first), minimal chrome, single-accent interactive color (Action Blue #0066cc), and whisper-soft elevation. Key constraints:
- Typography: SF Pro Display/Text, 17px body (not 16px), negative letter-spacing on display sizes
- Colors: One accent blue (#0066cc) for all interactions; near-black ink (#1d1d1f) for text; light canvas (#ffffff) and parchment (#f5f5f7) alternating surfaces
- Spacing: 8px base unit; 80px sections, 24px cards
- Shapes: Pill-radius CTAs, 18px card radius, no decorative shadows (product render shadow only)
- Elevation: Surface-color change, not shadows; backdrop-blur on sticky bars only

### 2.2 Simple Web Form
- Read-only view of all current env vars (masked sensitive keys) in a clean grid
- Form inputs for each editable variable, styled as `search-input` component (pill-shaped, 44px height)
- Confirm dialog with two blue pill CTAs ("Cancel" / "Apply")
- Success/error notifications using `button-primary` styling

### 2.3 Security Indicators
- Show which variables are considered "sensitive" (TOKEN, SECRET, KEY, PASSWORD) with visual badge
- Sensitive vars rendered on dark tiles (`surface-tile-1`) with Sky Link Blue text for contrast
- Visual hint that changing certain vars may require app restart (red accent or exclamation icon in near-black)
- Clear labeling of PostgreSQL vs Slack vs LinkedIn credentials in `typography.caption` (14px)

### 2.4 Audit Log UI
- Sortable table of recent changes using `store-utility-card` component styling
- Filter toolbar above the table with `search-input` for key names
- Show before/after values (redacted for sensitive vars) with pill-shaped "redacted" badges
- Rows alternate light/parchment for readability; timestamp and actor in `typography.fine-print` (12px)

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

## Design System Reference

The UI is built on Apple's design language documented in `plans/apple-design.md`. Key tokens:
- **Colors**: `{colors.primary}` (#0066cc) for all actions; `{colors.ink}` (#1d1d1f) for body text
- **Typography**: `{typography.body}` (SF Pro Text 17px/400) for paragraphs; `{typography.display-lg}` (SF Pro Display 40px/600) for section heads
- **Components**: `{component.button-primary}` for main CTAs; `{component.store-utility-card}` for the audit log table
- **Spacing**: `{spacing.lg}` (24px) for card padding; `{spacing.section}` (80px) for section vertical padding
- **Shapes**: `{rounded.pill}` for pill CTAs; `{rounded.lg}` (18px) for utility cards; no decoration shadows

## Post-Launch Refinements

- Add variable templates (LinkedIn version, reminder window, etc.) with preset values
- Suggest "safe to change now" vars based on time-of-day and deployment windows
- Slack notifications on every config change (with @mentions for sensitive vars)
- Bulk import from Railway export (one-time CSV/JSON migration tool)
- Dark mode support using Apple's dark-tile palette (surface-tile-1, primary-on-dark)
