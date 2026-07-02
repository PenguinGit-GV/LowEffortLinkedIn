# LowEffortLinkedIn
Low Effort employee advocacy tool for startups who have employees with LinkedIn disabilities.

See [docs/PLAN.md](docs/PLAN.md) for the feature spec and implementation plan, [docs/SETUP.md](docs/SETUP.md) for the Phase 0 setup guide (Railway, Slack app, LinkedIn app), and [PRIVACY.md](PRIVACY.md) for the privacy policy.

## Local development

Requires Node 20+ and a Postgres to point at (local `docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16`, or the Railway database's public URL).

```sh
npm install
cp .env.example .env    # fill in values — see comments in the file
npm run migrate         # create users/posts/shares tables
npm test                # unit + route tests (no Slack/LinkedIn/DB needed)
npm run dev             # start with auto-reload on :3000
```

`GET /healthz` reports server + database status.

Keep `LINKEDIN_MOCK_MODE=true` locally — shares are simulated and nothing is posted to LinkedIn.

**Receiving Slack traffic locally:** Slack must reach your machine over HTTPS, so run a tunnel — `ngrok http 3000` — then temporarily point the Slack app's three slash-command URLs and the Interactivity request URL at `https://<your-tunnel>/slack/events` (Slack app settings → your app). Point them back at the Railway domain when done. Alternatively, create a second throwaway Slack app from `slack-app-manifest.yaml` with the tunnel URL and a test workspace, and leave the production app untouched.
