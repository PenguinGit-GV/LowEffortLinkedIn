// Slack WebClient with tightly bounded retries — shared by the server's
// notification client, both cron jobs, and (via server.js's clientOptions)
// Bolt's own per-handler client. @slack/web-api's default policy is ten
// retries over ~30 minutes, which would keep a handler or job run alive for
// the duration of a Slack outage; every call site here is either best-effort
// (notifications, probes) or retried on its own schedule (cron), so failing
// fast is the right trade everywhere.

const { WebClient } = require('@slack/web-api');

const BOUNDED_RETRY_CONFIG = { retries: 2, minTimeout: 500, maxTimeout: 2000 };

function createBoundedSlackClient(token) {
  return new WebClient(token, { retryConfig: BOUNDED_RETRY_CONFIG });
}

module.exports = { createBoundedSlackClient, BOUNDED_RETRY_CONFIG };
