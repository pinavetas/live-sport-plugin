'use strict';

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

const { safeFetch } = require('../src/impitClient');
const LiveTVProvider = require('../src/providers/LiveTVProvider');

// A replay page with no embeddable clip resolves to a single "Web" fallback
// stream, which is enough to tell a cached empty answer from a fresh one.
const PAGE_HTML = '<html><body><h1>Replay</h1></body></html>';
const PATH = '/enx/showvideo/12345/';

describe('LiveTVProvider stream cache and empty results', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    safeFetch.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    console.warn.mockRestore();
  });

  async function resolve(provider) {
    const p = provider.resolveStream(PATH, 'football', null, { name: 'Replay' });
    // httpGet backs off between attempts/mirrors; drain those timers.
    await jest.runAllTimersAsync();
    return p;
  }

  test('a transient failure is not cached for the full replay TTL', async () => {
    const provider = new LiveTVProvider();
    provider._emptyCacheTtlMs = 60 * 1000;

    safeFetch.mockRejectedValue(new Error('ECONNRESET'));
    await expect(resolve(provider)).resolves.toEqual([]);

    // Upstream recovers.
    safeFetch.mockReset();
    safeFetch.mockResolvedValue({ ok: true, status: 200, text: async () => PAGE_HTML });

    // Within the short empty TTL the empty answer is still served from cache...
    await expect(resolve(provider)).resolves.toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();

    // ...but well inside the 6h positive TTL it is retried and succeeds.
    jest.advanceTimersByTime(61 * 1000);
    const streams = await resolve(provider);
    expect(safeFetch).toHaveBeenCalled();
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain(PATH);
  });

  test('non-empty results keep the long TTL', async () => {
    const provider = new LiveTVProvider();
    safeFetch.mockResolvedValue({ ok: true, status: 200, text: async () => PAGE_HTML });
    const first = await resolve(provider);
    expect(first).toHaveLength(1);
    const calls = safeFetch.mock.calls.length;

    jest.advanceTimersByTime(2 * 3600 * 1000);
    await expect(resolve(provider)).resolves.toEqual(first);
    expect(safeFetch.mock.calls.length).toBe(calls);
  });
});
