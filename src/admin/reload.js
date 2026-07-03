// Actually applies a config change to the running process — the piece
// overrides.js (Phase 1) deliberately stays blind to, per its own design
// note. Three strategies, matching allowList.js's RELOAD enum:
//
//   MUTATE  — write straight onto the shared live config object; every
//             handler already reads config.foo fresh per call, so this is
//             enough on its own.
//   CRON    — REMINDER_CRON/POST_EXPIRY_CRON are captured once at
//             cronLib.schedule() time inside start*Job(); mutating the
//             config object alone does not reschedule anything already
//             running (spec Finding F2). This stops the old task and starts
//             a fresh one with the new schedule.
//   RESTART — can't be done in-process (e.g. LINKEDIN_MOCK_MODE gates which
//             client was constructed at boot). Intentionally a no-op here:
//             the value is already persisted and takes effect on the next
//             process start; POST /admin/api/restart is how an admin
//             triggers that.

const { RELOAD, getEntry } = require('./allowList');
const { startExpiryReminderJob } = require('../jobs/expiryReminder');
const { startPostExpiryJob } = require('../jobs/postExpiry');

const CRON_JOBS = {
  REMINDER_CRON: { jobKey: 'reminderJob', start: startExpiryReminderJob },
  POST_EXPIRY_CRON: { jobKey: 'postExpiryJob', start: startPostExpiryJob },
};

// `config` is the live, shared, mutable object the rest of the app reads
// from. `jobs` is a mutable holder ({ reminderJob, postExpiryJob }) for the
// two cron task handles, owned by index.js, so this controller and the
// shutdown hook are always looking at the current task, never a stale one
// captured at boot.
function createReloadController({ config, db, jobs = {}, logger = console }) {
  function applyReload(key, runtimeValue) {
    const entry = getEntry(key);
    if (!entry) return;

    if (entry.reload === RELOAD.RESTART) return;

    config[entry.configKey] = runtimeValue;
    if (entry.reload !== RELOAD.CRON) return;

    const cronJob = CRON_JOBS[key];
    if (!cronJob) return;
    const current = jobs[cronJob.jobKey];
    if (!current) {
      // Defensive, not expected in production (index.js always wires jobs
      // before traffic is accepted) — but a missing handle shouldn't crash
      // an otherwise-successful config write. The value is still applied to
      // `config` above, so the new schedule takes effect once a job does
      // start reading it.
      logger.warn(`${key} changed but no running cron job handle was found to restart`);
      return;
    }
    current.stop();
    jobs[cronJob.jobKey] = cronJob.start({ config, db, logger });
  }

  return { applyReload };
}

module.exports = { createReloadController };
