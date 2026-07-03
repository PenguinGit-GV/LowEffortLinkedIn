const {
  parseSubmission,
  publishPost,
  buildModal,
  registerCreatePost,
  CAPTION_MAX,
  URL_MAX,
} = require('../src/handlers/createPost');

function values(overrides = {}) {
  return {
    destination_url: { value: { value: 'https://example.com/launch' } },
    caption_a: { value: { value: 'Caption A' } },
    caption_b: { value: { value: null } },
    caption_c: { value: { value: null } },
    image: { value: { files: [] } },
    ...overrides,
  };
}

const OPTS = { defaultExpiryHours: 8 };

describe('parseSubmission', () => {
  test('parses a valid minimal submission, defaulting the expiry window', () => {
    const { parsed, errors } = parseSubmission(values(), OPTS);
    expect(errors).toBeNull();
    expect(parsed).toEqual({
      destination_url: 'https://example.com/launch',
      caption_a: 'Caption A',
      caption_b: null,
      caption_c: null,
      image_slack_file_id: null,
      expiry_hours: 8,
    });
  });

  test('captures optional captions and the image file id', () => {
    const { parsed } = parseSubmission(
      values({
        caption_b: { value: { value: '  B text  ' } },
        image: { value: { files: [{ id: 'F123' }] } },
      }),
      OPTS
    );
    expect(parsed.caption_b).toBe('B text');
    expect(parsed.image_slack_file_id).toBe('F123');
  });

  test('rejects a malformed URL', () => {
    const { errors } = parseSubmission(
      values({ destination_url: { value: { value: 'not a url' } } }),
      OPTS
    );
    expect(errors.destination_url).toMatch(/valid URL/);
  });

  test('rejects non-http(s) protocols', () => {
    const { errors } = parseSubmission(
      values({ destination_url: { value: { value: 'javascript:alert(1)' } } }),
      OPTS
    );
    expect(errors.destination_url).toMatch(/http/);
  });

  test('rejects a missing caption A', () => {
    const { errors } = parseSubmission(values({ caption_a: { value: { value: '   ' } } }), OPTS);
    expect(errors.caption_a).toMatch(/required/);
  });

  test('rejects captions over the LinkedIn limit', () => {
    const { errors } = parseSubmission(
      values({ caption_b: { value: { value: 'x'.repeat(CAPTION_MAX + 1) } } }),
      OPTS
    );
    expect(errors.caption_b).toMatch(/3000/);
  });

  test('rejects a URL too long for the card section', () => {
    const longUrl = `https://example.com/${'a'.repeat(URL_MAX)}`;
    const { errors } = parseSubmission(
      values({ destination_url: { value: { value: longUrl } } }),
      OPTS
    );
    expect(errors.destination_url).toMatch(/too long/);
  });

  test('rejects a caption that would overflow the LinkedIn limit once the URL is appended (image posts)', () => {
    const url = `https://example.com/${'p'.repeat(100)}`;
    const { errors } = parseSubmission(
      values({
        destination_url: { value: { value: url } },
        caption_b: { value: { value: 'y'.repeat(CAPTION_MAX - 50) } },
        image: { value: { files: [{ id: 'F123' }] } },
      }),
      OPTS
    );
    expect(errors.caption_b).toMatch(/image/);
  });

  test('the same caption+URL combination is fine without an image', () => {
    const url = `https://example.com/${'p'.repeat(100)}`;
    const { errors } = parseSubmission(
      values({
        destination_url: { value: { value: url } },
        caption_b: { value: { value: 'y'.repeat(CAPTION_MAX - 50) } },
      }),
      OPTS
    );
    expect(errors).toBeNull();
  });

  test('rejects a caption that only overflows once mrkdwn-escaped', () => {
    // Raw length is exactly at the LinkedIn cap, but every & becomes &amp;.
    const ampersandHeavy = '&'.repeat(CAPTION_MAX);
    const { errors } = parseSubmission(
      values({ caption_a: { value: { value: ampersandHeavy } } }),
      OPTS
    );
    expect(errors.caption_a).toMatch(/special characters/);
  });

  describe('expiry_hours', () => {
    test('an explicit value overrides the default', () => {
      const { parsed } = parseSubmission(
        values({ expiry_hours: { value: { value: '24' } } }),
        OPTS
      );
      expect(parsed.expiry_hours).toBe(24);
    });

    test('blank falls back to the default', () => {
      const { parsed } = parseSubmission(
        values({ expiry_hours: { value: { value: '' } } }),
        { defaultExpiryHours: 8 }
      );
      expect(parsed.expiry_hours).toBe(8);
    });

    test('rejects zero, negative, non-numeric, and out-of-bounds values', () => {
      for (const bad of ['0', '-5', 'soon', '721']) {
        const { errors } = parseSubmission(
          values({ expiry_hours: { value: { value: bad } } }),
          OPTS
        );
        expect(errors.expiry_hours).toBeDefined();
      }
    });

    test('accepts the upper bound (720)', () => {
      const { parsed, errors } = parseSubmission(
        values({ expiry_hours: { value: { value: '720' } } }),
        OPTS
      );
      expect(errors).toBeNull();
      expect(parsed.expiry_hours).toBe(720);
    });
  });
});

describe('view handler glue', () => {
  function register() {
    const handlers = {};
    const app = {
      command: jest.fn((name, fn) => (handlers.command = fn)),
      view: jest.fn((id, fn) => (handlers.view = fn)),
    };
    const db = (table) => ({
      insert: () => ({ returning: async () => [{ id: 'post-uuid-1' }] }),
      where: () => ({ update: async () => 1, del: async () => 1 }),
    });
    const config = {
      advocacyChannelIds: ['C_ADVOCACY'],
      marketerSlackIds: ['U_MARKETER'],
      defaultPostExpiryHours: 8,
    };
    // Stubbed so tests never make a real HTTP request for the page title.
    const fetchArticleTitle = jest.fn().mockResolvedValue('Stubbed Page Title');
    registerCreatePost(app, { config, db, fetchArticleTitle });
    return { handlers, config, fetchArticleTitle };
  }

  test('acks with field errors for an invalid submission', async () => {
    const { handlers } = register();
    const ack = jest.fn();
    await handlers.view({
      ack,
      body: { user: { id: 'U_MARKETER' } },
      view: {
        private_metadata: JSON.stringify({ channel_id: 'C_ORIGIN' }),
        state: { values: values({ destination_url: { value: { value: 'nope' } } }) },
      },
      client: { chat: {} },
      logger: { error: jest.fn(), warn: jest.fn() },
    });
    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: expect.objectContaining({ destination_url: expect.stringMatching(/valid URL/) }),
    });
  });

  test('acks cleanly and publishes for a valid submission', async () => {
    const { handlers, fetchArticleTitle } = register();
    const ack = jest.fn();
    const client = {
      chat: {
        postMessage: jest.fn().mockResolvedValue({ channel: 'C_ADVOCACY', ts: '9.9' }),
        postEphemeral: jest.fn().mockResolvedValue({}),
      },
    };
    await handlers.view({
      ack,
      body: { user: { id: 'U_MARKETER' } },
      view: {
        private_metadata: JSON.stringify({ channel_id: 'C_ORIGIN' }),
        state: { values: values() },
      },
      client,
      logger: { error: jest.fn(), warn: jest.fn() },
    });
    expect(ack).toHaveBeenCalledWith();
    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(fetchArticleTitle).toHaveBeenCalledWith('https://example.com/launch', expect.anything());
  });

  test('rejects non-marketers at the command with C10', async () => {
    const { handlers } = register();
    const ack = jest.fn();
    const respond = jest.fn();
    const client = { views: { open: jest.fn() } };
    await handlers.command({
      ack,
      respond,
      client,
      logger: { error: jest.fn() },
      command: { user_id: 'U_RANDO', channel_id: 'C_ORIGIN', trigger_id: 't' },
    });
    expect(ack).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', text: expect.stringContaining('🚫') })
    );
    expect(client.views.open).not.toHaveBeenCalled();
  });
});

describe('buildModal', () => {
  test('carries the origin channel in private_metadata and caps caption length', () => {
    const modal = buildModal({ channelId: 'C_ORIGIN', defaultExpiryHours: 8 });
    expect(JSON.parse(modal.private_metadata)).toEqual({ channel_id: 'C_ORIGIN' });
    const captionBlock = modal.blocks.find((b) => b.block_id === 'caption_a');
    expect(captionBlock.element.max_length).toBe(CAPTION_MAX);
    const imageBlock = modal.blocks.find((b) => b.block_id === 'image');
    expect(imageBlock.optional).toBe(true);
    expect(imageBlock.element.max_files).toBe(1);
  });

  test('the expiry field is optional, numeric, bounded, and shows the default', () => {
    const modal = buildModal({ channelId: 'C_ORIGIN', defaultExpiryHours: 8 });
    const expiryBlock = modal.blocks.find((b) => b.block_id === 'expiry_hours');
    expect(expiryBlock.optional).toBe(true);
    expect(expiryBlock.element.type).toBe('number_input');
    expect(expiryBlock.element.min_value).toBe('1');
    expect(expiryBlock.element.max_value).toBe('720');
    expect(expiryBlock.label.text).toContain('8');
  });
});

describe('publishPost', () => {
  function makeDbStub() {
    const calls = { inserts: [], updates: [], deletes: [], cardInserts: [] };
    const db = (table) => {
      if (table === 'post_cards') {
        return {
          insert: async (rows) => {
            calls.cardInserts.push({ table, rows });
            return rows;
          },
        };
      }
      return {
        insert: (row) => ({
          returning: async () => {
            calls.inserts.push({ table, row });
            return [{ id: 'post-uuid-1' }];
          },
        }),
        where: (cond) => ({
          update: async (patch) => {
            calls.updates.push({ table, cond, patch });
            return 1;
          },
          del: async () => {
            calls.deletes.push({ table, cond });
            return 1;
          },
        }),
      };
    };
    db.calls = calls;
    return db;
  }

  const config = { advocacyChannelIds: ['C_ADVOCACY'] };
  const parsed = {
    destination_url: 'https://example.com',
    caption_a: 'A',
    caption_b: null,
    caption_c: null,
    image_slack_file_id: null,
    expiry_hours: 8,
  };
  // Stubbed in every test below so nothing here makes a real HTTP request.
  const fetchArticleTitle = () => Promise.resolve('Stubbed Page Title');

  test('inserts, broadcasts, stores the card location, and confirms', async () => {
    const db = makeDbStub();
    const client = {
      chat: {
        postMessage: jest.fn().mockResolvedValue({ channel: 'C_ADVOCACY', ts: '111.222' }),
        postEphemeral: jest.fn().mockResolvedValue({}),
      },
    };

    const before = Date.now();
    await publishPost(
      { db, client, config, logger: console, fetchArticleTitle },
      { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
    );

    const insertedRow = db.calls.inserts[0].row;
    expect(insertedRow.created_by_slack_id).toBe('U_MARKETER');
    expect(insertedRow.article_title).toBe('Stubbed Page Title');
    // expiry_hours is consumed to compute expires_at, not stored as its own column.
    expect(insertedRow.expiry_hours).toBeUndefined();
    const expiresAt = insertedRow.expires_at.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 8 * 3600 * 1000 - 2000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 3600 * 1000 + 2000);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_ADVOCACY', unfurl_links: true })
    );
    expect(db.calls.updates[0]).toEqual({
      table: 'posts',
      cond: { id: 'post-uuid-1' },
      patch: { slack_channel_id: 'C_ADVOCACY', slack_message_ts: '111.222' },
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_ORIGIN', user: 'U_MARKETER' })
    );
    expect(db.calls.deletes).toHaveLength(0);
  });

  test('deletes the orphaned row and reports when the broadcast fails', async () => {
    const db = makeDbStub();
    const failure = new Error('An API error occurred');
    failure.data = { error: 'channel_not_found' };
    const client = {
      chat: {
        postMessage: jest.fn().mockRejectedValue(failure),
        postEphemeral: jest.fn().mockResolvedValue({}),
      },
    };

    await publishPost(
      { db, client, config, logger: { warn: jest.fn() }, fetchArticleTitle },
      { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
    );

    expect(db.calls.deletes[0].cond).toEqual({ id: 'post-uuid-1' });
    expect(db.calls.updates).toHaveLength(0);
    const message = client.chat.postEphemeral.mock.calls[0][0];
    expect(message.text).toContain("can't post");
  });

  test('a failed confirmation does not fail the flow', async () => {
    const db = makeDbStub();
    const ephemeralFailure = new Error('failed');
    ephemeralFailure.data = { error: 'channel_not_found' };
    const client = {
      chat: {
        postMessage: jest.fn().mockResolvedValue({ channel: 'C_ADVOCACY', ts: '1.2' }),
        postEphemeral: jest.fn().mockRejectedValue(ephemeralFailure),
      },
    };

    await expect(
      publishPost(
        { db, client, config, logger: { warn: jest.fn() }, fetchArticleTitle },
        { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
      )
    ).resolves.toBeUndefined();
    expect(db.calls.updates).toHaveLength(1);
  });

  test('broadcasts to multiple channels and stores the first post location', async () => {
    const db = makeDbStub();
    const multiConfig = { advocacyChannelIds: ['C_ADVOCACY1', 'C_ADVOCACY2'] };
    const client = {
      chat: {
        postMessage: jest
          .fn()
          .mockResolvedValueOnce({ channel: 'C_ADVOCACY1', ts: '111.222' })
          .mockResolvedValueOnce({ channel: 'C_ADVOCACY2', ts: '333.444' }),
        postEphemeral: jest.fn().mockResolvedValue({}),
      },
    };

    await publishPost(
      { db, client, config: multiConfig, logger: console, fetchArticleTitle },
      { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
    );

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ channel: 'C_ADVOCACY1' })
    );
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ channel: 'C_ADVOCACY2' })
    );
    // Records a post_cards row for every channel that received the card.
    expect(db.calls.cardInserts).toHaveLength(1);
    expect(db.calls.cardInserts[0].rows).toEqual([
      { post_id: 'post-uuid-1', slack_channel_id: 'C_ADVOCACY1', slack_message_ts: '111.222' },
      { post_id: 'post-uuid-1', slack_channel_id: 'C_ADVOCACY2', slack_message_ts: '333.444' },
    ]);
    // Stores the first broadcast's location as the post's primary card.
    expect(db.calls.updates[0]).toEqual({
      table: 'posts',
      cond: { id: 'post-uuid-1' },
      patch: { slack_channel_id: 'C_ADVOCACY1', slack_message_ts: '111.222' },
    });
    expect(db.calls.deletes).toHaveLength(0);
  });

  test('reports partial broadcast failures but succeeds if at least one channel works', async () => {
    const db = makeDbStub();
    const multiConfig = { advocacyChannelIds: ['C_ADVOCACY1', 'C_ADVOCACY2'] };
    const failure = new Error('An API error occurred');
    failure.data = { error: 'channel_not_found' };
    const warn = jest.fn();
    const client = {
      chat: {
        postMessage: jest
          .fn()
          .mockResolvedValueOnce({ channel: 'C_ADVOCACY1', ts: '111.222' })
          .mockRejectedValueOnce(failure),
        postEphemeral: jest.fn().mockResolvedValue({}),
      },
    };

    await publishPost(
      { db, client, config: multiConfig, logger: { warn }, fetchArticleTitle },
      { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
    );

    // Post was created and stored despite one channel failing.
    expect(db.calls.updates).toHaveLength(1);
    expect(db.calls.deletes).toHaveLength(0);
    // Only the channel that succeeded gets a post_cards row.
    expect(db.calls.cardInserts[0].rows).toEqual([
      { post_id: 'post-uuid-1', slack_channel_id: 'C_ADVOCACY1', slack_message_ts: '111.222' },
    ]);
    // The failure is logged for the operator.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('C_ADVOCACY2'));
    // The marketer's confirmation lists only the channel that received the card.
    const confirmation = client.chat.postEphemeral.mock.calls[0][0].text;
    expect(confirmation).toContain('<#C_ADVOCACY1>');
    expect(confirmation).not.toContain('<#C_ADVOCACY2>');
  });

  test('propagates a title-fetch failure rather than silently posting without one', async () => {
    // fetchArticleTitle's real implementation never rejects (it falls back
    // to the hostname internally) — this guards against a future regression
    // where an override or refactor reintroduces an unhandled rejection here.
    const db = makeDbStub();
    const client = { chat: { postMessage: jest.fn(), postEphemeral: jest.fn() } };
    const failingFetch = () => Promise.reject(new Error('boom'));

    await expect(
      publishPost(
        { db, client, config, logger: { warn: jest.fn() }, fetchArticleTitle: failingFetch },
        { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
      )
    ).rejects.toThrow('boom');
    expect(db.calls.inserts).toHaveLength(0);
  });
});
