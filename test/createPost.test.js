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

describe('parseSubmission', () => {
  test('parses a valid minimal submission', () => {
    const { parsed, errors } = parseSubmission(values());
    expect(errors).toBeNull();
    expect(parsed).toEqual({
      destination_url: 'https://example.com/launch',
      caption_a: 'Caption A',
      caption_b: null,
      caption_c: null,
      image_slack_file_id: null,
    });
  });

  test('captures optional captions and the image file id', () => {
    const { parsed } = parseSubmission(
      values({
        caption_b: { value: { value: '  B text  ' } },
        image: { value: { files: [{ id: 'F123' }] } },
      })
    );
    expect(parsed.caption_b).toBe('B text');
    expect(parsed.image_slack_file_id).toBe('F123');
  });

  test('rejects a malformed URL', () => {
    const { errors } = parseSubmission(values({ destination_url: { value: { value: 'not a url' } } }));
    expect(errors.destination_url).toMatch(/valid URL/);
  });

  test('rejects non-http(s) protocols', () => {
    const { errors } = parseSubmission(
      values({ destination_url: { value: { value: 'javascript:alert(1)' } } })
    );
    expect(errors.destination_url).toMatch(/http/);
  });

  test('rejects a missing caption A', () => {
    const { errors } = parseSubmission(values({ caption_a: { value: { value: '   ' } } }));
    expect(errors.caption_a).toMatch(/required/);
  });

  test('rejects captions over the LinkedIn limit', () => {
    const { errors } = parseSubmission(
      values({ caption_b: { value: { value: 'x'.repeat(CAPTION_MAX + 1) } } })
    );
    expect(errors.caption_b).toMatch(/3000/);
  });

  test('rejects a URL too long for the card section', () => {
    const longUrl = `https://example.com/${'a'.repeat(URL_MAX)}`;
    const { errors } = parseSubmission(values({ destination_url: { value: { value: longUrl } } }));
    expect(errors.destination_url).toMatch(/too long/);
  });

  test('rejects a caption that would overflow the LinkedIn limit once the URL is appended (image posts)', () => {
    const url = `https://example.com/${'p'.repeat(100)}`;
    const { errors } = parseSubmission(
      values({
        destination_url: { value: { value: url } },
        caption_b: { value: { value: 'y'.repeat(CAPTION_MAX - 50) } },
        image: { value: { files: [{ id: 'F123' }] } },
      })
    );
    expect(errors.caption_b).toMatch(/image/);
  });

  test('the same caption+URL combination is fine without an image', () => {
    const url = `https://example.com/${'p'.repeat(100)}`;
    const { errors } = parseSubmission(
      values({
        destination_url: { value: { value: url } },
        caption_b: { value: { value: 'y'.repeat(CAPTION_MAX - 50) } },
      })
    );
    expect(errors).toBeNull();
  });

  test('rejects a caption that only overflows once mrkdwn-escaped', () => {
    // Raw length is exactly at the LinkedIn cap, but every & becomes &amp;.
    const ampersandHeavy = '&'.repeat(CAPTION_MAX);
    const { errors } = parseSubmission(
      values({ caption_a: { value: { value: ampersandHeavy } } })
    );
    expect(errors.caption_a).toMatch(/special characters/);
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
    const config = { advocacyChannelId: 'C_ADVOCACY', marketerSlackIds: ['U_MARKETER'] };
    registerCreatePost(app, { config, db });
    return { handlers, config };
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
    const { handlers } = register();
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
    const modal = buildModal({ channelId: 'C_ORIGIN' });
    expect(JSON.parse(modal.private_metadata)).toEqual({ channel_id: 'C_ORIGIN' });
    const captionBlock = modal.blocks.find((b) => b.block_id === 'caption_a');
    expect(captionBlock.element.max_length).toBe(CAPTION_MAX);
    const imageBlock = modal.blocks.find((b) => b.block_id === 'image');
    expect(imageBlock.optional).toBe(true);
    expect(imageBlock.element.max_files).toBe(1);
  });
});

describe('publishPost', () => {
  function makeDbStub() {
    const calls = { inserts: [], updates: [], deletes: [] };
    const db = (table) => ({
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
    });
    db.calls = calls;
    return db;
  }

  const config = { advocacyChannelId: 'C_ADVOCACY' };
  const parsed = {
    destination_url: 'https://example.com',
    caption_a: 'A',
    caption_b: null,
    caption_c: null,
    image_slack_file_id: null,
  };

  test('inserts, broadcasts, stores the card location, and confirms', async () => {
    const db = makeDbStub();
    const client = {
      chat: {
        postMessage: jest.fn().mockResolvedValue({ channel: 'C_ADVOCACY', ts: '111.222' }),
        postEphemeral: jest.fn().mockResolvedValue({}),
      },
    };

    await publishPost(
      { db, client, config, logger: console },
      { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
    );

    expect(db.calls.inserts[0].row.created_by_slack_id).toBe('U_MARKETER');
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
      { db, client, config, logger: { warn: jest.fn() } },
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
        { db, client, config, logger: { warn: jest.fn() } },
        { parsed, userId: 'U_MARKETER', originChannelId: 'C_ORIGIN' }
      )
    ).resolves.toBeUndefined();
    expect(db.calls.updates).toHaveLength(1);
  });
});
