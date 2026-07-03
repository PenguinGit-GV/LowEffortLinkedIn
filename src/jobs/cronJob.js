// Shared scaffolding for the scheduled jobs: validate the cron expression
// (fail fast at boot on a bad REMINDER_CRON/POST_EXPIRY_CRON, before traffic
// is accepted), build a bounded-retry Slack client, and schedule the run
// with a catch so one failed pass never kills the schedule. overrides let
// tests stub cron and Slack, and let the admin reload controller's restop
// path reuse the exact same start behavior.

const cron = require('node-cron');
const { createBoundedSlackClient } = require('../slack/client');

function startCronJob({ config, db, logger = console }, overrides, { envVarName, cronExpression, run, label }) {
  const cronLib = overrides.cronLib || cron;
  if (!cronLib.validate(cronExpression)) {
    throw new Error(`${envVarName} is not a valid cron expression: "${cronExpression}"`);
  }
  const slackClient = overrides.slackClient || createBoundedSlackClient(config.slackBotToken);

  return cronLib.schedule(
    cronExpression,
    () => {
      run({ db, config, slackClient, logger }).catch((err) =>
        logger.error(`${label} job failed:`, err)
      );
    },
    { timezone: 'Etc/UTC' }
  );
}

module.exports = { startCronJob };
