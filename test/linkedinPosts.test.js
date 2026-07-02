const { buildSharePayload, createShareClient } = require('../src/linkedin/posts');

describe('buildSharePayload', () => {
  const base = {
    personId: 'AbC123',
    commentary: 'Great read!',
    destinationUrl: 'https://example.com/post',
  };

  test('link-only post uses content.article and untouched commentary', () => {
    const payload = buildSharePayload({ ...base, imageUrn: null });
    expect(payload).toEqual({
      author: 'urn:li:person:AbC123',
      commentary: 'Great read!',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED' },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: { article: { source: 'https://example.com/post' } },
    });
  });

  test('image post uses content.media and appends the URL to the commentary', () => {
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
