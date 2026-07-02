const copy = require('../src/copy');
const { registerDisconnect } = require('../src/handlers/disconnect');

function setup({ updateError = null } = {}) {
  const calls = { updates: [], deletes: [] };
  const db = (table) => ({
    where: (cond) => ({
      update: async (patch) => {
        if (updateError) throw updateError;
        calls.updates.push({ table, cond, patch });
        return 1;
      },
      del: async () => {
        calls.deletes.push({ table, cond });
        return 1;
      },
    }),
  });
  db.fn = { now: () => 'NOW' };

  let handler;
  const app = { command: (name, fn) => (handler = fn) };
  registerDisconnect(app, { db });
  return { handler, calls };
}

const logger = { error: jest.fn() };

describe('/disconnect', () => {
  test('no args clears the connection, keeps history, responds C7', async () => {
    const { handler, calls } = setup();
    const ack = jest.fn();
    const respond = jest.fn();
    await handler({ command: { user_id: 'U777', text: '' }, ack, respond, logger });

    expect(ack).toHaveBeenCalled();
    expect(calls.deletes).toHaveLength(0);
    expect(calls.updates).toEqual([
      {
        table: 'users',
        cond: { slack_user_id: 'U777' },
        patch: expect.objectContaining({
          linkedin_access_token: null,
          linkedin_person_id: null,
          token_expires_at: null,
          expiry_reminder_sent_at: null,
        }),
      },
    ]);
    expect(respond).toHaveBeenCalledWith({ response_type: 'ephemeral', text: copy.C7 });
  });

  test('"all" deletes the users row (cascade erases history), responds C8', async () => {
    const { handler, calls } = setup();
    const respond = jest.fn();
    await handler({ command: { user_id: 'U777', text: '  ALL ' }, ack: jest.fn(), respond, logger });

    expect(calls.updates).toHaveLength(0);
    expect(calls.deletes).toEqual([{ table: 'users', cond: { slack_user_id: 'U777' } }]);
    expect(respond).toHaveBeenCalledWith({ response_type: 'ephemeral', text: copy.C8 });
  });

  test('unknown argument is treated as a plain disconnect, not erasure', async () => {
    const { handler, calls } = setup();
    const respond = jest.fn();
    await handler({
      command: { user_id: 'U777', text: 'everything' },
      ack: jest.fn(),
      respond,
      logger,
    });
    expect(calls.deletes).toHaveLength(0);
    expect(calls.updates).toHaveLength(1);
    expect(respond).toHaveBeenCalledWith({ response_type: 'ephemeral', text: copy.C7 });
  });

  test('acts only on the caller — the target comes from command.user_id', async () => {
    const { handler, calls } = setup();
    await handler({
      command: { user_id: 'U_CALLER', text: 'all' },
      ack: jest.fn(),
      respond: jest.fn(),
      logger,
    });
    expect(calls.deletes[0].cond).toEqual({ slack_user_id: 'U_CALLER' });
  });

  test('a DB failure still answers the user', async () => {
    const { handler } = setup({ updateError: new Error('connection refused') });
    const respond = jest.fn();
    await handler({ command: { user_id: 'U777', text: '' }, ack: jest.fn(), respond, logger });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Something went wrong') })
    );
  });
});
