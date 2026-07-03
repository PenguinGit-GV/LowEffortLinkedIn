require('dotenv').config();

const { loadConfig } = require('./config');
const { createDb } = require('./db/knex');
const { createServer } = require('./server');
const { startExpiryReminderJob } = require('./jobs/expiryReminder');
const { startPostExpiryJob } = require('./jobs/postExpiry');

async function main() {
  // envConfig is the pristine, never-mutated snapshot of Railway's env vars.
  // config (passed to createServer, jobs, and every handler) is a live copy
  // the admin config UI's reload controller mutates in place for
  // hot-reloadable variables (plans/env-var-ui-feature-spec.md Phase 3) —
  // keeping them separate means resetting an override always compares
  // against the true env default, not whatever the live object currently
  // holds.
  const envConfig = loadConfig();
  const config = { ...envConfig };
  const db = createDb(config);
  // Mutable holder so the reload controller's cron-job restop (stop the old
  // task, start a new one with the updated schedule) and this file's
  // shutdown hook always reference the current task, never one captured at
  // boot.
  const jobs = { reminderJob: null, postExpiryJob: null };
  const { app } = createServer(config, db, { envConfig, jobs });

  // Fail fast on a bad REMINDER_CRON/POST_EXPIRY_CRON before traffic is accepted.
  jobs.reminderJob = startExpiryReminderJob({ config, db });
  jobs.postExpiryJob = startPostExpiryJob({ config, db });

  await app.start(config.port);
  console.log(
    `⚡ LowEffortLinkedIn listening on :${config.port}` +
      ` (env: ${config.nodeEnv}, LinkedIn mock mode: ${config.linkedinMockMode},` +
      ` reminder cron: ${config.reminderCron}, post expiry: ${config.defaultPostExpiryHours}h` +
      ` default / ${config.postExpiryCron})`
  );

  // Railway sends SIGTERM on redeploys; drain in-flight requests and release
  // the pool instead of dropping them mid-handler.
  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    // db.destroy() waits on pending pool acquires, which can stall for the
    // full acquire timeout when the database is unreachable — force-exit as a
    // backstop so the container never hangs past its host's grace period.
    setTimeout(() => {
      console.error('Graceful shutdown stalled, forcing exit');
      process.exit(1);
    }, 10000).unref();
    try {
      jobs.reminderJob.stop();
      jobs.postExpiryJob.stop();
      await app.stop();
      await db.destroy();
      process.exit(0);
    } catch (err) {
      console.error('Shutdown failed:', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
