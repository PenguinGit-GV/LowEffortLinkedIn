// Finding F2 fix under test: cron schedules are captured once at
// cronLib.schedule() time, so mutating config alone doesn't reschedule a
// running task — applyReload must stop the old one and start a fresh one.

jest.mock('../../src/jobs/expiryReminder');
jest.mock('../../src/jobs/postExpiry');

const { startExpiryReminderJob } = require('../../src/jobs/expiryReminder');
const { startPostExpiryJob } = require('../../src/jobs/postExpiry');
const { createReloadController } = require('../../src/admin/reload');

function newTask(name) {
  return { name, stop: jest.fn() };
}

describe('applyReload — MUTATE', () => {
  test('writes the new value straight onto the live config object', () => {
    const config = { publicBaseUrl: 'https://old.example.com' };
    const { applyReload } = createReloadController({ config, db: {}, jobs: {} });
    applyReload('PUBLIC_BASE_URL', 'https://new.example.com');
    expect(config.publicBaseUrl).toBe('https://new.example.com');
  });
});

describe('applyReload — RESTART', () => {
  test('does not mutate the live config (a restart is required to pick it up)', () => {
    const config = { linkedinMockMode: true };
    const { applyReload } = createReloadController({ config, db: {}, jobs: {} });
    applyReload('LINKEDIN_MOCK_MODE', false);
    expect(config.linkedinMockMode).toBe(true);
  });
});

describe('applyReload — CRON', () => {
  test('stops the old reminder job and starts a new one with the updated config', () => {
    const oldTask = newTask('old-reminder');
    const newTaskHandle = newTask('new-reminder');
    startExpiryReminderJob.mockReturnValue(newTaskHandle);

    const config = { reminderCron: '0 9 * * *' };
    const db = {};
    const jobs = { reminderJob: oldTask };
    const { applyReload } = createReloadController({ config, db, jobs });

    applyReload('REMINDER_CRON', '0 12 * * *');

    expect(config.reminderCron).toBe('0 12 * * *');
    expect(oldTask.stop).toHaveBeenCalledTimes(1);
    expect(startExpiryReminderJob).toHaveBeenCalledWith(expect.objectContaining({ config, db }));
    expect(jobs.reminderJob).toBe(newTaskHandle);
  });

  test('stops the old post-expiry job and starts a new one', () => {
    const oldTask = newTask('old-expiry');
    const newTaskHandle = newTask('new-expiry');
    startPostExpiryJob.mockReturnValue(newTaskHandle);

    const config = { postExpiryCron: '*/15 * * * *' };
    const jobs = { postExpiryJob: oldTask };
    const { applyReload } = createReloadController({ config, db: {}, jobs });

    applyReload('POST_EXPIRY_CRON', '*/5 * * * *');

    expect(config.postExpiryCron).toBe('*/5 * * * *');
    expect(oldTask.stop).toHaveBeenCalledTimes(1);
    expect(jobs.postExpiryJob).toBe(newTaskHandle);
  });

  test('still applies the config value, and logs a warning instead of throwing, when no job handle exists', () => {
    const config = { reminderCron: '0 9 * * *' };
    const logger = { warn: jest.fn() };
    const { applyReload } = createReloadController({ config, db: {}, jobs: {}, logger });

    expect(() => applyReload('REMINDER_CRON', '0 12 * * *')).not.toThrow();
    expect(config.reminderCron).toBe('0 12 * * *');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('REMINDER_CRON'));
  });
});

describe('applyReload — unmanaged key', () => {
  test('is a silent no-op', () => {
    const config = { foo: 'bar' };
    const { applyReload } = createReloadController({ config, db: {}, jobs: {} });
    expect(() => applyReload('DATABASE_URL', 'x')).not.toThrow();
    expect(config).toEqual({ foo: 'bar' });
  });
});
