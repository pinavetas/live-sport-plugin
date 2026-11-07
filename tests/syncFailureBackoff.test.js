'use strict';

const CronService = require('../src/services/CronService');

describe('CronService backoff after failed syncs', () => {
  const prevPrewarm = process.env.CATALOG_MEMO_PREWARM;
  const MIN = 60 * 1000;

  beforeEach(() => {
    process.env.CATALOG_MEMO_PREWARM = 'false';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (prevPrewarm === undefined) delete process.env.CATALOG_MEMO_PREWARM;
    else process.env.CATALOG_MEMO_PREWARM = prevPrewarm;
  });

  // ensureFresh fires runSync without awaiting it; let that promise settle.
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  function makeService(syncMatches) {
    const cacheService = { isStale: () => true }; // cache never refreshes during an outage
    return new CronService({ matchAggregator: { syncMatches }, cacheService });
  }

  test('stale-triggered syncs back off exponentially (2, 4, 8, 15, 15 min) while every provider fails', async () => {
    const syncMatches = jest.fn(async () => null);
    const svc = makeService(syncMatches);

    svc.ensureFresh();
    await flush();
    expect(syncMatches).toHaveBeenCalledTimes(1);

    const expectedWaits = [2, 4, 8, 15, 15];
    for (let i = 0; i < expectedWaits.length; i++) {
      const wait = expectedWaits[i] * MIN;
      // Hammering the catalog inside the window does nothing.
      jest.advanceTimersByTime(wait - 1);
      for (let k = 0; k < 10; k++) svc.ensureFresh();
      await flush();
      expect(syncMatches).toHaveBeenCalledTimes(i + 1);
      // Once the window elapses the next stale request retries.
      jest.advanceTimersByTime(1);
      svc.ensureFresh();
      await flush();
      expect(syncMatches).toHaveBeenCalledTimes(i + 2);
    }
  });

  test('a throwing sync also backs off', async () => {
    const syncMatches = jest.fn(async () => { throw new Error('boom'); });
    const svc = makeService(syncMatches);

    svc.ensureFresh();
    await flush();
    expect(syncMatches).toHaveBeenCalledTimes(1);
    expect(svc.consecutiveSyncFailures).toBe(1);

    jest.advanceTimersByTime(1 * MIN);
    svc.ensureFresh();
    await flush();
    expect(syncMatches).toHaveBeenCalledTimes(1);
  });

  test('a successful sync resets the backoff', async () => {
    const syncMatches = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([])
      .mockResolvedValue(null);
    const svc = makeService(syncMatches);

    svc.ensureFresh(); await flush();          // fail #1 -> 2 min
    jest.advanceTimersByTime(2 * MIN);
    svc.ensureFresh(); await flush();          // success -> reset
    expect(svc.consecutiveSyncFailures).toBe(0);
    expect(svc.syncBackoffUntil).toBe(0);

    svc.ensureFresh(); await flush();          // fail again -> back to 2 min, not 4
    expect(syncMatches).toHaveBeenCalledTimes(3);
    expect(svc.syncBackoffUntil - Date.now()).toBe(2 * MIN);
  });

  test('scheduled (direct) syncs are not blocked by the backoff', async () => {
    const syncMatches = jest.fn(async () => null);
    const svc = makeService(syncMatches);

    await svc.runSync();
    expect(Date.now()).toBeLessThan(svc.syncBackoffUntil);
    await svc.runSync();
    expect(syncMatches).toHaveBeenCalledTimes(2);
    expect(svc.consecutiveSyncFailures).toBe(2);
  });
});
