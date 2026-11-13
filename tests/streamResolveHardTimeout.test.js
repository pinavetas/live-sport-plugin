'use strict';

// LiveTVProvider fetches through the guarded provider transport (fetchUndici).
jest.mock('../src/services/ProviderOutbound', () => ({
  ...jest.requireActual('../src/services/ProviderOutbound'),
  fetchUndici: jest.fn(),
}));
const providerOutbound = require('../src/services/ProviderOutbound');

const StreamResolveCache = require('../src/services/StreamResolveCache');
const LiveTVProvider = require('../src/providers/LiveTVProvider');

describe('StreamResolveCache hard mint timeout', () => {
  const originalShared = process.env.RESOLVE_CACHE_SHARED;

  beforeEach(() => {
    process.env.RESOLVE_CACHE_SHARED = 'false';
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = originalShared;
  });

  test('a mint that never settles releases the in-flight slot and is negative-cached', async () => {
    const cache = new StreamResolveCache({ resolveTimeoutMs: 1000, negativeTtlMs: 5000 });
    const hung = jest.fn(() => new Promise(() => {}));

    const first = cache.getOrCreate('provider:match:src', hung);
    // A concurrent caller joins the same in-flight mint.
    const joined = cache.getOrCreate('provider:match:src', hung);
    expect(cache.stats().inFlight).toBe(1);

    await jest.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toEqual([]);
    await expect(joined).resolves.toEqual([]);
    expect(hung).toHaveBeenCalledTimes(1);
    expect(cache.stats().inFlight).toBe(0);

    // Briefly negative-cached: no new mint inside the negative TTL...
    await expect(cache.getOrCreate('provider:match:src', hung)).resolves.toEqual([]);
    expect(hung).toHaveBeenCalledTimes(1);

    // ...and the source becomes usable again once it expires.
    await jest.advanceTimersByTimeAsync(5001);
    const ok = jest.fn(async () => [{ url: 'https://cdn.example/live.m3u8' }]);
    await expect(cache.getOrCreate('provider:match:src', ok)).resolves.toEqual([
      { url: 'https://cdn.example/live.m3u8' },
    ]);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  test('a late answer from a timed-out mint does not overwrite the cache', async () => {
    const cache = new StreamResolveCache({ resolveTimeoutMs: 1000, negativeTtlMs: 5000 });
    let resolveLate;
    const slow = () => new Promise((r) => { resolveLate = r; });

    const p = cache.getOrCreate('provider:match:src', slow);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual([]);

    resolveLate([{ url: 'https://late.example/x.m3u8' }]);
    await Promise.resolve();
    expect(cache.get('provider:match:src')).toBeNull();
  });

  test('a mint that finishes before the deadline is cached normally and clears its timer', async () => {
    const cache = new StreamResolveCache({ resolveTimeoutMs: 1000 });
    const fast = jest.fn(async () => [{ url: 'https://cdn.example/a.m3u8' }]);
    await expect(cache.getOrCreate('provider:match:src', fast)).resolves.toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(cache.isResolved('provider:match:src')).toBe(true);
  });
});

describe('LiveTVProvider unshorten', () => {
  afterEach(() => { providerOutbound.fetchUndici.mockReset(); });

  test('every hop carries an abort signal and has its body cancelled', async () => {
    const cancels = [];
    const signals = [];
    let hop = 0;
    providerOutbound.fetchUndici.mockImplementation(async (url, opts) => {
      signals.push(opts.signal);
      hop++;
      const cancel = jest.fn(async () => {});
      cancels.push(cancel);
      if (hop < 3) {
        return { status: 302, headers: { get: () => `https://short.example/${hop}` }, body: { cancel } };
      }
      return { status: 200, headers: { get: () => null }, body: { cancel } };
    });

    const out = await LiveTVProvider._unshorten('https://short.example/start');
    expect(out).toBe('https://short.example/2');
    expect(providerOutbound.fetchUndici).toHaveBeenCalledTimes(3);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
    for (const c of cancels) expect(c).toHaveBeenCalledTimes(1);
  });

  test('a hop that times out stops unshortening and returns the last known URL', async () => {
    providerOutbound.fetchUndici.mockImplementation((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    }));
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new Error('TimeoutError')), 10);
      return c.signal;
    });
    try {
      await expect(LiveTVProvider._unshorten('https://short.example/dead')).resolves.toBe('https://short.example/dead');
      expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
    } finally {
      AbortSignal.timeout.mockRestore();
    }
  });
});
