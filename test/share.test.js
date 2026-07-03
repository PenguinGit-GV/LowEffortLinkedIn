// Share pipeline tests — PLAN.md §2.3 steps 1–6 and §12.

const { loadConfig } = require('../src/config');
const { encryptToken } = require('../src/crypto/tokenCipher');
const {
  runSharePipeline,
  buildCustomShareModal,
  registerShareHandlers,
  CUSTOM_MODAL_CALLBACK_ID,
} = require('../src/handlers/share');
const copy = require('../src/copy');

const KEY = Buffer.alloc(32, 7);

function testConfig() {
  return loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'shhh',
    MARKETER_SLACK_IDS: 'U111',
    ADVOCACY_CHANNEL_ID: 'C123',
    DATABASE_URL: 'postgresql://localhost/test',
    OAUTH_STATE_SECRET: 'state-secret',
    TOKEN_ENCRYPTION_KEY: KEY.toString('base64'),
    PUBLIC_BASE_URL: 'https://example.up.railway.app',
    LINKEDIN_MOCK_MODE: 'true',
  });
}

const POST = {
  id: 'post-1',
  destination_url: 'https://example.com/blog',
  caption_a: 'Caption A text',
  caption_b: 'Caption B text',
  caption_c: null,
  image_slack_file_id: null,
  slack_channel_id: 'C123',
  slack_message_ts: '1719900000.000100',
  created_by_slack_id: 'U111',
  created_at: new Date('2026-07-01T00:00:00Z'),
};

function connectedUser(userId = 'U777') {
  return {
    slack_user_id: userId,
    linkedin_access_token: encryptToken('linkedin-token', KEY),
    linkedin_person_id: 'PERSON1',
    token_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  };
}

// Minimal knex fake covering the pipeline's query shapes; per-table behavior
// is configurable per test.
function fakeDb({
  post = POST,
  usersRow = connectedUser(),
  existingShare = null,
  successCount = 1,
  shareInsertError = null,
  cards = null,
} = {}) {
  const shareInserts = [];
  const userUpdates = [];
  // Default to a single card mirroring the post's primary columns, so
  // single-channel behavior is unchanged; pass `cards` to exercise fan-out.
  const postCards =
    cards ||
    (post.slack_channel_id && post.slack_message_ts
      ? [{ slack_channel_id: post.slack_channel_id, slack_message_ts: post.slack_message_ts }]
      : []);
  const db = (table) => {
    if (table === 'posts') {
      return { where: () => ({ first: async () => post }) };
    }
    if (table === 'post_cards') {
      return { where: () => ({ select: async () => postCards }) };
    }
    if (table === 'shares') {
      return {
        where: () => ({
          first: async () => existingShare,
          count: async () => [{ count: String(successCount) }],
        }),
        insert: async (row) => {
          if (shareInsertError && row.status === 'success') throw shareInsertError;
          shareInserts.push(row);
        },
      };
    }
    if (table === 'users') {
      return {
        where: () => ({
          first: async () => usersRow,
          update: async (patch) => {
            userUpdates.push(patch);
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  db.fn = { now: () => new Date() };
  return { db, shareInserts, userUpdates };
}

function fakeClient() {
  return {
    chat: {
      postEphemeral: jest.fn().mockResolvedValue({ ok: true }),
      update: jest.fn().mockResolvedValue({ ok: true }),
    },
    reactions: { add: jest.fn().mockResolvedValue({ ok: true }) },
    views: { open: jest.fn().mockResolvedValue({ ok: true }) },
    files: { info: jest.fn() },
  };
}

const quietLogger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };

function okShareClient() {
  return {
    uploadImage: jest.fn().mockResolvedValue('urn:li:image:img1'),
    createPost: jest.fn().mockResolvedValue('urn:li:share:new1'),
  };
}

function deps(overrides = {}) {
  const dbParts = overrides.dbParts || fakeDb();
  return {
    config: testConfig(),
    db: dbParts.db,
    shareClient: overrides.shareClient || okShareClient(),
    client: overrides.client || fakeClient(),
    logger: quietLogger,
    ...(overrides.fetchFile ? { fetchFile: overrides.fetchFile } : {}),
    _dbParts: dbParts,
  };
}

const JOB = {
  postId: 'post-1',
  variation: 'A',
  customText: null,
  userId: 'U777',
  channelId: 'C123',
};

describe('runSharePipeline', () => {
  test('happy path: posts to LinkedIn, records the share, confirms, updates the card', async () => {
    const d = deps();
    await runSharePipeline(d, JOB);

    expect(d.shareClient.createPost).toHaveBeenCalledTimes(1);
    const { accessToken, payload } = d.shareClient.createPost.mock.calls[0][0];
    expect(accessToken).toBe('linkedin-token');
    expect(payload.author).toBe('urn:li:person:PERSON1');
    expect(payload.commentary).toBe('Caption A text');
    expect(payload.content).toEqual({
      article: { source: 'https://example.com/blog', title: 'example.com' },
    });

    expect(d._dbParts.shareInserts).toEqual([
      expect.objectContaining({
        post_id: 'post-1',
        slack_user_id: 'U777',
        variation: 'A',
        custom_text: null,
        linkedin_post_urn: 'urn:li:share:new1',
        status: 'success',
      }),
    ]);

    expect(d.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', user: 'U777', text: copy.C3 })
    );
    const update = d.client.chat.update.mock.calls[0][0];
    expect(update.channel).toBe('C123');
    expect(update.ts).toBe('1719900000.000100');
    const blocksJson = JSON.stringify(update.blocks);
    expect(blocksJson).toContain('✅ 1 share');
    expect(blocksJson).not.toContain('✅ 1 shares');
    // First successful share → ✅ reaction.
    expect(d.client.reactions.add).toHaveBeenCalledTimes(1);
  });

  test('no reaction after the first share', async () => {
    const d = deps({ dbParts: fakeDb({ successCount: 2 }) });
    await runSharePipeline(d, JOB);
    expect(d.client.reactions.add).not.toHaveBeenCalled();
    expect(JSON.stringify(d.client.chat.update.mock.calls[0][0].blocks)).toContain('✅ 2 shares');
  });

  test('multi-channel post: every card gets the counter update and first-share reaction', async () => {
    const cards = [
      { slack_channel_id: 'C_ONE', slack_message_ts: '1.1' },
      { slack_channel_id: 'C_TWO', slack_message_ts: '2.2' },
    ];
    const d = deps({ dbParts: fakeDb({ cards }) });
    await runSharePipeline(d, JOB);

    expect(d.client.chat.update).toHaveBeenCalledTimes(2);
    const updatedChannels = d.client.chat.update.mock.calls.map((c) => c[0].channel);
    expect(updatedChannels).toEqual(['C_ONE', 'C_TWO']);
    // First successful share → ✅ reaction on each card.
    expect(d.client.reactions.add).toHaveBeenCalledTimes(2);
  });

  test('one card failing to update does not block the others', async () => {
    const cards = [
      { slack_channel_id: 'C_ONE', slack_message_ts: '1.1' },
      { slack_channel_id: 'C_TWO', slack_message_ts: '2.2' },
    ];
    const client = fakeClient();
    client.chat.update
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { data: { error: 'message_not_found' } }))
      .mockResolvedValueOnce({ ok: true });
    const d = deps({ dbParts: fakeDb({ cards }), client });
    await runSharePipeline(d, JOB);

    expect(d.client.chat.update).toHaveBeenCalledTimes(2); // both attempted despite the first failing
  });

  test('variation CUSTOM posts the edited text and stores custom_text', async () => {
    const d = deps();
    await runSharePipeline(d, { ...JOB, variation: 'CUSTOM', customText: 'My own words' });
    expect(d.shareClient.createPost.mock.calls[0][0].payload.commentary).toBe('My own words');
    expect(d._dbParts.shareInserts[0]).toEqual(
      expect.objectContaining({ variation: 'CUSTOM', custom_text: 'My own words' })
    );
  });

  test('not connected → connect prompt, no LinkedIn call, no share row', async () => {
    // null (not undefined) so the destructuring default doesn't kick in.
    const d = deps({ dbParts: fakeDb({ usersRow: null }) });
    await runSharePipeline(d, JOB);
    expect(d.shareClient.createPost).not.toHaveBeenCalled();
    expect(d._dbParts.shareInserts).toHaveLength(0);
    const msg = d.client.chat.postEphemeral.mock.calls[0][0];
    expect(msg.text).toContain('Connect your LinkedIn');
  });

  test('undecryptable stored token → connect prompt, no LinkedIn call', async () => {
    const row = { ...connectedUser(), linkedin_access_token: 'not-really-encrypted' };
    const d = deps({ dbParts: fakeDb({ usersRow: row }) });
    await runSharePipeline(d, JOB);
    expect(d.shareClient.createPost).not.toHaveBeenCalled();
    expect(d.client.chat.postEphemeral.mock.calls[0][0].text).toContain('Connect your LinkedIn');
  });

  test('already shared (pre-check) → C4, no LinkedIn call', async () => {
    const d = deps({ dbParts: fakeDb({ existingShare: { id: 'share-0' } }) });
    await runSharePipeline(d, JOB);
    expect(d.shareClient.createPost).not.toHaveBeenCalled();
    expect(d.client.chat.postEphemeral.mock.calls[0][0].text).toBe(copy.C4);
  });

  test('expired post → C12, no LinkedIn call, no share row (even if the card still shows buttons)', async () => {
    const expiredPost = { ...POST, expires_at: new Date(Date.now() - 60_000) };
    const d = deps({ dbParts: fakeDb({ post: expiredPost }) });
    await runSharePipeline(d, JOB);
    expect(d.shareClient.createPost).not.toHaveBeenCalled();
    expect(d._dbParts.shareInserts).toHaveLength(0);
    expect(d.client.chat.postEphemeral.mock.calls[0][0].text).toBe(copy.C12);
  });

  test('a post whose window has not yet passed shares normally', async () => {
    const activePost = { ...POST, expires_at: new Date(Date.now() + 60_000) };
    const d = deps({ dbParts: fakeDb({ post: activePost }) });
    await runSharePipeline(d, JOB);
    expect(d.shareClient.createPost).toHaveBeenCalledTimes(1);
  });

  test('unique violation on insert (layer-2 race) → C4', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    const d = deps({ dbParts: fakeDb({ shareInsertError: err }) });
    await runSharePipeline(d, JOB);
    expect(d.client.chat.postEphemeral.mock.calls[0][0].text).toBe(copy.C4);
    expect(d.client.chat.update).not.toHaveBeenCalled();
  });

  test('LinkedIn failure → failed row recorded, C6 with the error surfaced', async () => {
    const shareClient = okShareClient();
    shareClient.createPost.mockRejectedValue({
      response: { status: 422, data: { message: 'Content is a duplicate' } },
      message: 'Request failed with status code 422',
    });
    const d = deps({ shareClient });
    await runSharePipeline(d, JOB);
    expect(d._dbParts.shareInserts).toEqual([
      expect.objectContaining({ status: 'failed', error_message: 'Content is a duplicate' }),
    ]);
    const msg = d.client.chat.postEphemeral.mock.calls[0][0].text;
    expect(msg).toContain('Content is a duplicate');
    expect(msg).toContain('<@U111>');
    expect(d.client.chat.update).not.toHaveBeenCalled();
  });

  test('huge LinkedIn error → C6 stays under Slack limits, full text in the DB row', async () => {
    const bigError = 'E'.repeat(5000);
    const shareClient = okShareClient();
    shareClient.createPost.mockRejectedValue({
      response: { status: 422, data: { message: bigError } },
      message: 'Request failed',
    });
    const d = deps({ shareClient });
    await runSharePipeline(d, JOB);

    const msg = d.client.chat.postEphemeral.mock.calls[0][0].text;
    expect(msg.length).toBeLessThan(1000);
    expect(msg).toContain('…');
    expect(d._dbParts.shareInserts[0].error_message).toHaveLength(2000);
  });

  test('a 401 from the image CDN PUT is a share failure, not a revocation', async () => {
    const post = { ...POST, image_slack_file_id: 'F123' };
    const fetchFile = jest.fn().mockResolvedValue(Buffer.from('png'));
    const shareClient = okShareClient();
    const cdnErr = Object.assign(new Error('upload url expired'), {
      response: { status: 401 },
      isCdnUpload: true,
    });
    shareClient.uploadImage.mockRejectedValue(cdnErr);
    const d = deps({ dbParts: fakeDb({ post }), shareClient, fetchFile });
    await runSharePipeline(d, JOB);

    expect(d._dbParts.userUpdates).toHaveLength(0); // token NOT cleared
    expect(d._dbParts.shareInserts[0]).toEqual(expect.objectContaining({ status: 'failed' }));
    const msg = d.client.chat.postEphemeral.mock.calls[0][0].text;
    expect(msg).not.toContain('Connect your LinkedIn');
    expect(msg).toContain('upload url expired');
  });

  test('LinkedIn 401 → token cleared, connect prompt, failed row (trigger point 3)', async () => {
    const shareClient = okShareClient();
    shareClient.createPost.mockRejectedValue({ response: { status: 401 }, message: '401' });
    const d = deps({ shareClient });
    await runSharePipeline(d, JOB);
    expect(d._dbParts.userUpdates).toEqual([
      expect.objectContaining({ linkedin_access_token: null, linkedin_person_id: null }),
    ]);
    expect(d.client.chat.postEphemeral.mock.calls[0][0].text).toContain('Connect your LinkedIn');
    expect(d._dbParts.shareInserts[0]).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  test('image post: fetch + upload under the sharer token, media payload', async () => {
    const post = { ...POST, image_slack_file_id: 'F123' };
    const fetchFile = jest.fn().mockResolvedValue(Buffer.from('png-bytes'));
    const d = deps({ dbParts: fakeDb({ post }), fetchFile });
    await runSharePipeline(d, JOB);

    expect(fetchFile).toHaveBeenCalledWith(expect.anything(), 'F123');
    expect(d.shareClient.uploadImage).toHaveBeenCalledWith({
      accessToken: 'linkedin-token',
      personId: 'PERSON1',
      bytes: Buffer.from('png-bytes'),
    });
    const { payload } = d.shareClient.createPost.mock.calls[0][0];
    expect(payload.content).toEqual({ media: { id: 'urn:li:image:img1' } });
    expect(payload.commentary).toBe('Caption A text\n\nhttps://example.com/blog');
  });

  test('image fetch failure → share fails loudly with C6, LinkedIn never called', async () => {
    const post = { ...POST, image_slack_file_id: 'F123' };
    const fetchFile = jest.fn().mockRejectedValue(new Error('file fetch broke'));
    const d = deps({ dbParts: fakeDb({ post }), fetchFile });
    await runSharePipeline(d, JOB);

    expect(d.shareClient.createPost).not.toHaveBeenCalled();
    expect(d._dbParts.shareInserts[0]).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(d.client.chat.postEphemeral.mock.calls[0][0].text).toContain('file fetch broke');
  });

  test('double-click: the in-flight lock lets only one run through', async () => {
    let releasePostLookup;
    const gate = new Promise((resolve) => {
      releasePostLookup = resolve;
    });
    const dbParts = fakeDb();
    const slowDb = (table) => {
      if (table === 'posts') {
        return { where: () => ({ first: () => gate.then(() => POST) }) };
      }
      return dbParts.db(table);
    };
    slowDb.fn = dbParts.db.fn;

    const d = { ...deps(), db: slowDb, _dbParts: dbParts };
    const first = runSharePipeline(d, JOB);
    const second = runSharePipeline(d, JOB);
    releasePostLookup();
    await Promise.all([first, second]);

    expect(d.shareClient.createPost).toHaveBeenCalledTimes(1);
    expect(dbParts.shareInserts).toHaveLength(1);
  });

  test('missing caption variation (stale card) → friendly error, no crash', async () => {
    const d = deps();
    await runSharePipeline(d, { ...JOB, variation: 'C' });
    expect(d.shareClient.createPost).not.toHaveBeenCalled();
    expect(d.client.chat.postEphemeral.mock.calls[0][0].text).toContain('no longer available');
  });
});

describe('buildCustomShareModal', () => {
  test('pre-fills Caption A and carries post/channel in metadata', () => {
    const view = buildCustomShareModal({ post: POST, channelId: 'C123' });
    expect(view.callback_id).toBe(CUSTOM_MODAL_CALLBACK_ID);
    expect(view.blocks[0].element.initial_value).toBe('Caption A text');
    expect(JSON.parse(view.private_metadata)).toEqual({ post_id: 'post-1', channel_id: 'C123' });
  });
});

describe('registered handlers', () => {
  function captureHandlers(dbParts) {
    const handlers = { actions: [], views: [] };
    const app = {
      action: (id, fn) => handlers.actions.push([id, fn]),
      view: (id, fn) => handlers.views.push([id, fn]),
    };
    registerShareHandlers(app, {
      config: testConfig(),
      db: dbParts.db,
      shareClient: okShareClient(),
    });
    return handlers;
  }

  test('share button handler acks, parses the value, and runs the pipeline', async () => {
    const dbParts = fakeDb();
    const handlers = captureHandlers(dbParts);
    const [pattern, fn] = handlers.actions[0];
    expect('share_variation_a').toMatch(pattern);
    expect('share_variation_c').toMatch(pattern);
    expect('edit_share_custom').not.toMatch(pattern);

    const ack = jest.fn();
    const client = fakeClient();
    await fn({
      ack,
      body: { user: { id: 'U777' }, channel: { id: 'C123' } },
      action: { value: JSON.stringify({ post_id: 'post-1', variation: 'B' }) },
      client,
      logger: quietLogger,
    });
    expect(ack).toHaveBeenCalled();
    expect(dbParts.shareInserts[0]).toEqual(expect.objectContaining({ variation: 'B' }));
  });

  test('custom modal submission rejects an empty caption with a field error', async () => {
    const handlers = captureHandlers(fakeDb());
    const [, fn] = handlers.views[0];
    const ack = jest.fn();
    await fn({
      ack,
      body: { user: { id: 'U777' } },
      view: {
        private_metadata: JSON.stringify({ post_id: 'post-1', channel_id: 'C123' }),
        state: { values: { custom_caption: { value: { value: '   ' } } } },
      },
      client: fakeClient(),
      logger: quietLogger,
    });
    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: { custom_caption: 'A caption is required.' },
    });
  });

  test('custom modal submission enforces the caption+URL budget for image posts', async () => {
    const post = {
      ...POST,
      image_slack_file_id: 'F123',
      destination_url: `https://example.com/${'x'.repeat(200)}`,
    };
    const handlers = captureHandlers(fakeDb({ post }));
    const [, fn] = handlers.views[0];
    const ack = jest.fn();
    await fn({
      ack,
      body: { user: { id: 'U777' } },
      view: {
        private_metadata: JSON.stringify({ post_id: 'post-1', channel_id: 'C123' }),
        state: { values: { custom_caption: { value: { value: 'y'.repeat(2900) } } } },
      },
      client: fakeClient(),
      logger: quietLogger,
    });
    const ackArg = ack.mock.calls[0][0];
    expect(ackArg.response_action).toBe('errors');
    expect(ackArg.errors.custom_caption).toContain('image');
  });

  test('edit button: a DB failure still gives the user feedback', async () => {
    const brokenDb = () => ({
      where: () => ({ first: async () => { throw new Error('connection refused'); } }),
    });
    brokenDb.fn = { now: () => new Date() };
    const handlers = { actions: [], views: [] };
    const app = {
      action: (id, fn) => handlers.actions.push([id, fn]),
      view: (id, fn) => handlers.views.push([id, fn]),
    };
    registerShareHandlers(app, { config: testConfig(), db: brokenDb, shareClient: okShareClient() });
    const [, fn] = handlers.actions.find(([id]) => id === 'edit_share_custom');

    const client = fakeClient();
    await fn({
      ack: jest.fn(),
      body: { user: { id: 'U777' }, channel: { id: 'C123' }, trigger_id: 't' },
      action: { value: JSON.stringify({ post_id: 'post-1' }) },
      client,
      logger: quietLogger,
    });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toContain('Could not open the editor');
  });

  test('custom modal: a pre-ack DB failure keeps the modal open with a field error', async () => {
    const brokenDb = () => ({
      where: () => ({ first: async () => { throw new Error('connection refused'); } }),
    });
    brokenDb.fn = { now: () => new Date() };
    const handlers = { actions: [], views: [] };
    const app = {
      action: (id, fn) => handlers.actions.push([id, fn]),
      view: (id, fn) => handlers.views.push([id, fn]),
    };
    registerShareHandlers(app, { config: testConfig(), db: brokenDb, shareClient: okShareClient() });
    const [, fn] = handlers.views[0];

    const ack = jest.fn();
    await fn({
      ack,
      body: { user: { id: 'U777' } },
      view: {
        private_metadata: JSON.stringify({ post_id: 'post-1', channel_id: 'C123' }),
        state: { values: { custom_caption: { value: { value: 'Fine caption' } } } },
      },
      client: fakeClient(),
      logger: quietLogger,
    });
    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: { custom_caption: expect.stringContaining('try submitting again') },
    });
  });

  test('custom modal submission runs the pipeline with variation CUSTOM', async () => {
    const dbParts = fakeDb();
    const handlers = captureHandlers(dbParts);
    const [, fn] = handlers.views[0];
    const ack = jest.fn();
    await fn({
      ack,
      body: { user: { id: 'U777' } },
      view: {
        private_metadata: JSON.stringify({ post_id: 'post-1', channel_id: 'C123' }),
        state: { values: { custom_caption: { value: { value: 'Edited caption' } } } },
      },
      client: fakeClient(),
      logger: quietLogger,
    });
    expect(ack).toHaveBeenCalledWith();
    expect(dbParts.shareInserts[0]).toEqual(
      expect.objectContaining({ variation: 'CUSTOM', custom_text: 'Edited caption' })
    );
  });
});
