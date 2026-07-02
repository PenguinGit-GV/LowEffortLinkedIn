const {
  parseWindowDays,
  formatLeaderboard,
  fetchLeaderboard,
  registerStats,
  DEFAULT_WINDOW_DAYS,
} = require('../src/handlers/stats');

describe('parseWindowDays', () => {
  test('defaults to 30 for empty/garbage input', () => {
    expect(parseWindowDays('')).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindowDays(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindowDays('soon')).toBe(DEFAULT_WINDOW_DAYS);
  });

  test('parses integers and clamps to 1–365', () => {
    expect(parseWindowDays('7')).toBe(7);
    expect(parseWindowDays(' 90 ')).toBe(90);
    expect(parseWindowDays('0')).toBe(1);
    expect(parseWindowDays('-5')).toBe(1);
    expect(parseWindowDays('9999')).toBe(365);
  });
});

describe('formatLeaderboard', () => {
  test('renders the header, mentions, ranks, and pluralized counts', () => {
    const text = formatLeaderboard(30, {
      total: 6,
      leaders: [
        { slack_user_id: 'U1', count: 5 },
        { slack_user_id: 'U2', count: 1 },
      ],
    });
    expect(text).toContain('last 30 days');
    expect(text).toContain('6 shares total');
    expect(text).toContain('1. <@U1> — 5 shares');
    expect(text).toContain('2. <@U2> — 1 share');
    expect(text).not.toContain('1 shares');
  });

  test('renders the empty state when there are no shares', () => {
    const text = formatLeaderboard(7, { total: 0, leaders: [] });
    expect(text).toContain('last 7 days');
    expect(text).toContain('be the first');
  });

  test('the header total pluralizes', () => {
    const one = formatLeaderboard(30, { total: 1, leaders: [{ slack_user_id: 'U1', count: 1 }] });
    expect(one).toContain('1 share total');
    expect(one).not.toContain('1 shares total');
    const many = formatLeaderboard(30, { total: 2, leaders: [{ slack_user_id: 'U1', count: 2 }] });
    expect(many).toContain('2 shares total');
  });
});

describe('fetchLeaderboard', () => {
  test('counts only successful shares in the window, top 10, numeric types', async () => {
    const captured = { wheres: [], limit: null };
    const builder = (rows) => {
      const b = {
        where: (...args) => {
          captured.wheres.push(args);
          return b;
        },
        count: (arg) => (arg ? b : Promise.resolve([{ count: '12' }])),
        select: () => b,
        groupBy: () => b,
        orderBy: () => b,
        limit: (n) => {
          captured.limit = n;
          return Promise.resolve(rows);
        },
      };
      return b;
    };
    const db = () => builder([{ slack_user_id: 'U1', count: '7' }]);

    const board = await fetchLeaderboard(db, 30);
    expect(board.total).toBe(12);
    expect(board.leaders).toEqual([{ slack_user_id: 'U1', count: 7 }]);
    expect(captured.limit).toBe(10);
    expect(captured.wheres).toEqual(
      expect.arrayContaining([
        ['status', 'success'],
        ['shared_at', '>=', expect.any(Date)],
      ])
    );
  });
});

describe('/advocacy-stats handler', () => {
  function setup(db) {
    let handler;
    const app = { command: (name, fn) => (handler = fn) };
    registerStats(app, { db });
    return handler;
  }

  test('acks, then responds ephemerally with the board', async () => {
    const builder = {
      where: () => builder,
      count: (arg) => (arg ? builder : Promise.resolve([{ count: '0' }])),
      select: () => builder,
      groupBy: () => builder,
      orderBy: () => builder,
      limit: () => Promise.resolve([]),
    };
    const handler = setup(() => builder);
    const ack = jest.fn();
    const respond = jest.fn();
    await handler({
      command: { user_id: 'U1', text: '14' },
      ack,
      respond,
      logger: { error: jest.fn() },
    });
    expect(ack).toHaveBeenCalled();
    const arg = respond.mock.calls[0][0];
    expect(arg.response_type).toBe('ephemeral');
    expect(arg.text).toContain('last 14 days');
    expect(arg.text).toContain('be the first');
  });

  test('a DB failure still answers the user', async () => {
    const handler = setup(() => {
      throw new Error('connection refused');
    });
    const respond = jest.fn();
    await handler({
      command: { user_id: 'U1', text: '' },
      ack: jest.fn(),
      respond,
      logger: { error: jest.fn() },
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Could not load') })
    );
  });
});
