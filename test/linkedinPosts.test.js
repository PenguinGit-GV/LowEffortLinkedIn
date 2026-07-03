jest.mock('axios');
const axios = require('axios');
const { buildSharePayload, createShareClient } = require('../src/linkedin/posts');

describe('buildSharePayload', () => {
  const base = {
    personId: 'AbC123',
    commentary: 'Great read!',
    destinationUrl: 'https://example.com/post',
    articleTitle: 'A Great Read — Example Blog',
  };

  test('link-only post uses content.article with the given title and untouched commentary', () => {
    const payload = buildSharePayload({ ...base, imageUrn: null });
    expect(payload).toEqual({
      author: 'urn:li:person:AbC123',
      commentary: 'Great read!',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED' },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        article: { source: 'https://example.com/post', title: 'A Great Read — Example Blog' },
      },
    });
  });

  test('image post uses content.media, appends the URL to the commentary, and carries no title', () => {
    const payload = buildSharePayload({ ...base, imageUrn: 'urn:li:image:xyz' });
    expect(payload.content).toEqual({ media: { id: 'urn:li:image:xyz' } });
    expect(payload.commentary).toBe('Great read!\n\nhttps://example.com/post');
    // content is a oneOf — never both.
    expect(payload.content.article).toBeUndefined();
  });
});

describe('createShareClient (mock mode)', () => {
  const config = { linkedinMockMode: true };
  const quiet = { log: jest.fn() };

  test('createPost returns a unique mock share URN without any HTTP', async () => {
    const client = createShareClient(config, { logger: quiet });
    const payload = { author: 'urn:li:person:x', commentary: 'hi' };
    const a = await client.createPost({ accessToken: 't', payload });
    const b = await client.createPost({ accessToken: 't', payload });
    expect(a).toMatch(/^urn:li:share:mock-/);
    expect(a).not.toBe(b);
  });

  test('uploadImage returns a mock image URN', async () => {
    const client = createShareClient(config, { logger: quiet });
    const urn = await client.uploadImage({ accessToken: 't', personId: 'x', bytes: Buffer.alloc(1) });
    expect(urn).toMatch(/^urn:li:image:mock-/);
  });
});

describe('createShareClient (real mode)', () => {
  const config = { linkedinMockMode: false, linkedinVersion: '202506' };

  beforeEach(() => jest.resetAllMocks());

  test('createPost sends versioned headers and returns the x-restli-id URN', async () => {
    axios.post.mockResolvedValue({ headers: { 'x-restli-id': 'urn:li:share:123' } });
    const client = createShareClient(config);
    const urn = await client.createPost({ accessToken: 'tok', payload: { author: 'a' } });
    expect(urn).toBe('urn:li:share:123');
    const [, , opts] = axios.post.mock.calls[0];
    expect(opts.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer tok',
        'LinkedIn-Version': '202506',
        'X-Restli-Protocol-Version': '2.0.0',
      })
    );
  });

  test('uploadImage tags CDN PUT failures so a 401 there is not read as revocation', async () => {
    axios.post.mockResolvedValue({
      data: { value: { uploadUrl: 'https://cdn.example/upload', image: 'urn:li:image:x' } },
    });
    axios.put.mockRejectedValue(
      Object.assign(new Error('denied'), { response: { status: 401 } })
    );
    const client = createShareClient(config);
    await expect(
      client.uploadImage({ accessToken: 'tok', personId: 'p', bytes: Buffer.alloc(1) })
    ).rejects.toMatchObject({ isCdnUpload: true, response: { status: 401 } });
  });

  test('uploadImage does NOT tag initializeUpload failures', async () => {
    axios.post.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { response: { status: 401 } })
    );
    const client = createShareClient(config);
    await expect(
      client.uploadImage({ accessToken: 'tok', personId: 'p', bytes: Buffer.alloc(1) })
    ).rejects.toMatchObject({ response: { status: 401 } });
    try {
      await client.uploadImage({ accessToken: 'tok', personId: 'p', bytes: Buffer.alloc(1) });
    } catch (err) {
      expect(err.isCdnUpload).toBeUndefined();
    }
  });
});
