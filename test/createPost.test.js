const { parseSubmission, publishPost, buildModal, CAPTION_MAX } = require('../src/handlers/createPost');

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
