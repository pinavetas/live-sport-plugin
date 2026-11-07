'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');
const CronService = require('../src/services/CronService');

const baseParams = {
  timStreamsProvider: null, watchFootyProvider: null, cdnLiveProvider: null,
  streamSports99Provider: null, streamedPkProvider: null, yamlProviders: [],
  replayzoneProvider: null, liveTvProvider: null,
  damiTvProvider: null, ppvStProvider: null, teamLogoService: null,
};

function fakeCache(previous = []) {
  return {
    written: null,
    getMatches() { return previous.map((m) => JSON.parse(JSON.stringify(m))); },
    setMatches(v) { this.written = v; },
    isStale() { return false; },
  };
}

const neverSettles = () => new Promise(() => {});

describe('MatchAggregator per-provider sync deadline', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('a provider that never settles is cut off and the sync completes with the others', async () => {
    const cache = fakeCache();
    const health = { registerProviders: jest.fn(), startSync: jest.fn(), recordResult: jest.fn(), finishSync: jest.fn(), recordCarryForward: jest.fn(), recordCached: jest.fn() };
    const agg = new MatchAggregator({ ...baseParams, cacheService: cache, providerHealthService: health });
    agg.providerSyncTimeoutMs = 50;
    const hung = { sourceName: 'hungtv', getMatches: jest.fn(neverSettles) };
    const healthy = { sourceName: 'cdnlive', getMatches: async () => ([{
      id: 'cdn_ch_a', title: 'Sky Sports', category: 'networks', date: '0',
      sources: [{ source: 'cdnlive', id: 'a' }],
    }]) };
    agg.providers = [hung, healthy];

    const result = await agg.syncMatches();

    expect(Array.isArray(result)).toBe(true);
    expect((cache.written || []).map((m) => m.id)).toContain('cdn_ch_a');
    const hungCall = health.recordResult.mock.calls.find(([p]) => p === hung);
    expect(hungCall[1].error).toBeInstanceOf(Error);
    expect(hungCall[1].error.message).toMatch(/timed out after 50ms/);
  });

  test('a timed-out provider is handled like a failed one (carry-forward of its previous rows)', async () => {
    const prevChannel = {
      id: 'dlv_ch_94', title: 'beIN Sports 4', category: 'networks', date: '0', isChannel: true,
      sources: [{ source: 'daddylive', id: '94' }],
    };
    const cache = fakeCache([prevChannel]);
    const agg = new MatchAggregator({ ...baseParams, cacheService: cache });
    agg.providerSyncTimeoutMs = 50;
    const hungDaddy = { sourceName: 'daddylive', getMatches: neverSettles };
    const other = { sourceName: 'cdnlive', getMatches: async () => ([{
      id: 'cdn_ch_z', title: 'Sky', category: 'networks', date: '0',
      sources: [{ source: 'cdnlive', id: 'z' }],
    }]) };
    agg.providers = [other, hungDaddy];

    await agg.syncMatches();

    const ids = (cache.written || []).map((m) => m.id);
    expect(ids).toContain('cdn_ch_z');
    expect(ids).toContain('dlv_ch_94');
  });

  test('a fast provider clears its deadline timer', async () => {
    jest.useFakeTimers();
    try {
      const agg = new MatchAggregator({ ...baseParams, cacheService: fakeCache() });
      const before = jest.getTimerCount();
      await agg._fetchProviderMatches({ getMatches: async () => [] });
      expect(jest.getTimerCount()).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('CronService sync watchdog', () => {
  const prevPrewarm = process.env.CATALOG_MEMO_PREWARM;
  beforeEach(() => {
    process.env.CATALOG_MEMO_PREWARM = 'false';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (prevPrewarm === undefined) delete process.env.CATALOG_MEMO_PREWARM;
    else process.env.CATALOG_MEMO_PREWARM = prevPrewarm;
  });

  test('a sync stuck past the watchdog no longer blocks later syncs', async () => {
    let finishSecond;
    const syncMatches = jest.fn()
      .mockImplementationOnce(neverSettles)
      .mockImplementationOnce(() => new Promise((r) => { finishSecond = r; }));
    const svc = new CronService({ matchAggregator: { syncMatches } });

    svc.runSync();
    expect(svc.isSyncing).toBe(true);

    // Within the watchdog window a second trigger is skipped as before.
    jest.advanceTimersByTime(60 * 1000);
    await svc.runSync();
    expect(syncMatches).toHaveBeenCalledTimes(1);

    // Past the watchdog, the stuck sync is abandoned and a new one starts.
    jest.advanceTimersByTime(5 * 60 * 1000);
    const second = svc.runSync();
    expect(syncMatches).toHaveBeenCalledTimes(2);
    expect(svc.isSyncing).toBe(true);

    finishSecond(null);
    await second;
    expect(svc.isSyncing).toBe(false);
  });

  test('an abandoned sync that settles late does not clear the newer sync flag', async () => {
    let finishFirst;
    const syncMatches = jest.fn()
      .mockImplementationOnce(() => new Promise((r) => { finishFirst = r; }))
      .mockImplementationOnce(neverSettles);
    const svc = new CronService({ matchAggregator: { syncMatches } });

    const first = svc.runSync();
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    svc.runSync();
    expect(syncMatches).toHaveBeenCalledTimes(2);

    finishFirst(null);
    await first;
    expect(svc.isSyncing).toBe(true);
  });

  test('ensureFresh also honours the watchdog', () => {
    const syncMatches = jest.fn(neverSettles);
    const cacheService = { isStale: () => true };
    const svc = new CronService({ matchAggregator: { syncMatches }, cacheService });

    svc.ensureFresh();
    svc.ensureFresh();
    expect(syncMatches).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    svc.ensureFresh();
    expect(syncMatches).toHaveBeenCalledTimes(2);
  });

  test('an externally set syncing flag (no start time) is respected', async () => {
    const syncMatches = jest.fn(async () => null);
    const svc = new CronService({ matchAggregator: { syncMatches } });
    svc.isSyncing = true;
    jest.advanceTimersByTime(60 * 60 * 1000);
    await svc.runSync();
    expect(syncMatches).not.toHaveBeenCalled();
  });
});
