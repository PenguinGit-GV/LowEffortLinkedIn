# Privacy Policy

**Effective date:** July 2, 2026

LowEffortLinkedIn is an internal tool for Dr. Claw Development employees. It lets a
marketer draft LinkedIn post ideas in Slack, and lets employees connect their
own LinkedIn account once and share those ideas to their personal LinkedIn
profile with one click. This policy explains what the app stores about you,
why, and what it does not do.

It is not a general-purpose consumer product — it is only used by
Dr. Claw Development employees inside Dr. Claw Development's Slack workspace.

## What we store

To do its job, the app keeps a minimal record tied to your Slack user ID:

- **Your Slack user ID** — to know it's you when you click a Share button.
- **A LinkedIn access token**, encrypted at rest — issued by LinkedIn when you
  connect your account, so the app can post on your behalf without asking you
  to log in every time. The app never sees or stores your LinkedIn password;
  authentication happens entirely on LinkedIn's own login screen.
- **Your LinkedIn person ID** and the token's expiration date — required by
  LinkedIn's API to address posts to the right account and to know when you'll
  need to reconnect.
- **A record of what you shared** — which post and variation, when, whether it
  succeeded, and the text actually posted (including any edits you made via
  "Edit & Share Custom").

Separately, the app stores the post content (destination URL and caption
options) that the marketer using `/create-post` writes. That content is
authored material for the campaign, not personal data about the employees who
may later share it.

## What we don't do

- We don't sell your data or share it with third parties, advertisers, or
  data brokers.
- We don't use your data for analytics, tracking, or advertising.
- We don't access your LinkedIn connections, messages, activity feed, or any
  part of your LinkedIn account beyond publishing the specific post you
  clicked "Share" or "Submit" on.
- We don't post to LinkedIn without your explicit action — every share is a
  direct result of you clicking a button or submitting a modal in Slack.

## How it's stored and secured

- LinkedIn access tokens are encrypted at rest.
- All traffic to and from the app is over HTTPS.
- Access to the underlying database is restricted to the app's own service.

## Retention and deletion

- LinkedIn access tokens expire automatically 60 days after you connect (per
  LinkedIn's own token lifetime) and are not renewed without your action.
- You can disconnect at any time, self-service, by running `/disconnect` in
  Slack — this deletes your stored LinkedIn token immediately (your share
  history is kept for the leaderboard). Run `/disconnect all` to also erase
  your share history and every record tied to your Slack ID.
- You can additionally revoke the app's access from your
  [LinkedIn account settings](https://www.linkedin.com/psettings/permitted-services),
  which invalidates the token on LinkedIn's side.
- To request deletion of your stored data (Slack ID, token record, or share
  history) by a human instead, contact hello@drclaw.dev.

## Third-party services

This app operates inside Slack and connects to LinkedIn's API on your behalf.
Slack's and LinkedIn's own privacy policies govern how each of those
platforms separately handles your data:

- [Slack Privacy Policy](https://slack.com/trust/privacy/privacy-policy)
- [LinkedIn Privacy Policy](https://www.linkedin.com/legal/privacy-policy)

## Changes to this policy

If what the app collects or how it's used changes, this document will be
updated and the effective date above will change accordingly.

## Contact

Questions about this policy or your data: hello@drclaw.dev.
