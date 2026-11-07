'use strict';

/**
 * DaddyLive sync fetches must reach a live backup mirror before the circuit
 * breaker around them fires. Previously the three mirrors were tried strictly
 * sequentially with a 12-18s budget each inside a 30s breaker, so when the
 * first two mirrors hung the third was never contacted.
 *
 * Pure unit tests with a fake proxyFetch - no network.
 */
const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');

const fakeCB = {
  wrap: (name, fn) => ({ fire: () => fn() }),
  wrapSync: (name, fn) => ({ fire: () => fn() }),
};

const CHANNELS_HTML = '<a href="/watch.php?id=94"><div class="card__title">beIN Sports 4</div></a>';
const SCHEDULE_HTML = '<div class="schedule__day"><div class="schedule__dayTitle">Friday</div><div class="schedule__category"><div class="schedule__categoryTitle">Soccer</div><div class="schedule__event"><div class="schedule__eventTime">20:00</div><div class="schedule__eventTitle">Arsenal vs Chelsea</div><div class="schedule__channels"><a href="/watch.php?id=35">Sky Sports</a></div></div></div></div>';

const CB_TIMEOUT_MS = 30000; // provider default (DADDYLIVE_CB_TIMEOUT_MS)

/** proxyFetch where the first two mirrors hang until aborted. */
function hangingFirstTwo(provider, body) {
  const calls = [];
  provider.proxyFetch = jest.fn((url, opts) => {
    calls.push({ url, opts, at: Date.now() });
    if (url.startsWith(provider.baseDomains[2])) {
      return Promise.resolve({ ok: true, text: async () => body });
    }
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  });
  return calls;
}

describe('DaddyLive mirror budget vs circuit breaker', () => {
  const prevSync = process.env.DADDYLIVE_SYNC_TIMEOUT_MS;
  const prevCb = process.env.DADDYLIVE_CB_TIMEOUT_MS;
  let provider;

  beforeEach(() => {
    // Pin the per-mirror budget at the 12s baseline (independent of host load).
    process.env.DADDYLIVE_SYNC_TIMEOUT_MS = '12000';
    delete process.env.DADDYLIVE_CB_TIMEOUT_MS;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    provider = new DaddyLiveProvider({ circuitBreaker: fakeCB });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (prevSync === undefined) delete process.env.DADDYLIVE_SYNC_TIMEOUT_MS;
    else process.env.DADDYLIVE_SYNC_TIMEOUT_MS = prevSync;
    if (prevCb === undefined) delete process.env.DADDYLIVE_CB_TIMEOUT_MS;
    else process.env.DADDYLIVE_CB_TIMEOUT_MS = prevCb;
  });

  test.each([
    ['fetchChannels', CHANNELS_HTML],
    ['fetchSchedule', SCHEDULE_HTML],
  ])('%s reaches the third mirror within the breaker timeout when the first two hang', async (method, body) => {
    const calls = hangingFirstTwo(provider, body);
    const start = Date.now();
    let result;
    let settled = false;
    provider[method].fire().then((v) => { result = v; settled = true; });

    await jest.advanceTimersByTimeAsync(CB_TIMEOUT_MS - 1);

    expect(settled).toBe(true);
    expect(result).toBeTruthy();
    expect(calls.map((c) => new URL(c.url).origin)).toEqual(provider.baseDomains);
    // The third mirror was contacted, and its budget ends before the breaker.
    const third = calls[2];
    expect(third.at - start).toBeLessThan(CB_TIMEOUT_MS);
    expect(third.at - start + third.opts.timeoutMs).toBeLessThanOrEqual(CB_TIMEOUT_MS);
    // The hung attempts are cancelled once a mirror answers.
    expect(calls[0].opts.signal.aborted).toBe(true);
    expect(calls[1].opts.signal.aborted).toBe(true);
  });

  test('a healthy first mirror is used alone (no extra mirror traffic)', async () => {
    provider.proxyFetch = jest.fn(async () => ({ ok: true, text: async () => CHANNELS_HTML }));
    await expect(provider.fetchChannels.fire()).resolves.toBe(CHANNELS_HTML);
    await jest.advanceTimersByTimeAsync(CB_TIMEOUT_MS);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(1);
    expect(provider.proxyFetch.mock.calls[0][1].timeoutMs).toBe(12000);
  });

  test('a fast failure moves to the next mirror immediately', async () => {
    provider.proxyFetch = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, text: async () => CHANNELS_HTML });
    await expect(provider.fetchChannels.fire()).resolves.toBe(CHANNELS_HTML);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(3);
  });

  test('when every mirror fails the last error is surfaced', async () => {
    provider.proxyFetch = jest.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'));
    await expect(provider.fetchChannels.fire()).rejects.toThrow('third');
  });

  test('all mirrors answering non-ok yields the descriptive error', async () => {
    provider.proxyFetch = jest.fn(async () => ({ ok: false, status: 404 }));
    await expect(provider.fetchSchedule.fire()).rejects.toThrow('All DaddyLive schedule endpoints failed');
    expect(provider.proxyFetch).toHaveBeenCalledTimes(3);
  });
});
