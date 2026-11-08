'use strict';

jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const cron = require('node-cron');
const CronService = require('../src/services/CronService');
const parserStudioRouter = require('../src/routes/parserStudio');
const dynamicParserRegistry = require('../src/services/DynamicParserRegistry');

function routeHandler(path, method) {
  const layer = parserStudioRouter.stack.find(r => r.route && (
    Array.isArray(r.route.path) ? r.route.path.includes(path) : r.route.path === path
  ) && r.route.methods[method]);
  return layer.route.stack[0].handle;
}

function mockRes() {
  const res = { statusCode: 200 };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

function makeContainer(services) {
  return { resolve: (name) => {
    if (!(name in services)) throw new Error(`no ${name}`);
    return services[name];
  } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('CronService', () => {
  test('start() no longer schedules a separate custom-AI crawl job', () => {
    cron.schedule.mockClear();
    const svc = new CronService({ matchAggregator: {}, cacheService: {} });
    svc.start();
    const schedules = cron.schedule.mock.calls.map(c => c[0]);
    expect(schedules).not.toContain('*/30 * * * *');
    expect(cron.schedule.mock.calls.some(c => String(c[1]).includes('dynamicParserRegistry'))).toBe(false);
  });

  test('requestSync starts a sync when idle', async () => {
    const syncMatches = jest.fn().mockResolvedValue(null);
    const svc = new CronService({ matchAggregator: { syncMatches }, cacheService: {} });
    await svc.requestSync();
    expect(syncMatches).toHaveBeenCalledTimes(1);
    expect(svc.syncing).toBe(false);
  });

  test('requestSync during a sync queues exactly one follow-up run', async () => {
    const first = deferred();
    const syncMatches = jest.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(null);
    const svc = new CronService({ matchAggregator: { syncMatches }, cacheService: {} });

    const running = svc.runSync();
    expect(svc.syncing).toBe(true);
    const a = svc.requestSync();
    const b = svc.requestSync();
    expect(a).toBe(b); // coalesced
    expect(syncMatches).toHaveBeenCalledTimes(1);

    first.resolve(null);
    await running;
    await a;
    expect(syncMatches).toHaveBeenCalledTimes(2);
  });
});

describe('Parser Studio save/sync go through the aggregator sync', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    dynamicParserRegistry.activeProviders.clear();
  });

  test('POST /save triggers the aggregator sync and never hand-merges the cache', async () => {
    const provider = { name: 'My Replays', sourceName: 'myreplays', getMatches: jest.fn() };
    jest.spyOn(dynamicParserRegistry, 'saveParser').mockReturnValue({ success: true, provider });
    const cronService = { requestSync: jest.fn().mockResolvedValue(undefined) };
    const cacheService = { getMatches: jest.fn(() => []), setMatches: jest.fn() };
    const container = makeContainer({ cronService, cacheService });

    const res = mockRes();
    await routeHandler('/save', 'post')({
      body: { config: { name: 'My Replays', baseUrl: 'https://x.example', selectors: { matches: '.a' } } },
      app: { get: () => container }
    }, res);
    await new Promise(r => setImmediate(r));

    expect(res.body).toEqual({
      success: true,
      message: "Parser 'My Replays' successfully activated and mounted in runtime",
      sourceName: 'myreplays'
    });
    expect(cronService.requestSync).toHaveBeenCalledTimes(1);
    expect(provider.getMatches).not.toHaveBeenCalled();
    expect(cacheService.setMatches).not.toHaveBeenCalled();
  });

  test('POST /sync awaits the aggregator sync and reports matches from the parser', async () => {
    const provider = { name: 'My Replays', sourceName: 'myreplays', getMatches: jest.fn() };
    dynamicParserRegistry.activeProviders.set('myreplays', provider);
    const cached = [
      { id: 'myreplays_1', sources: [{ source: 'myreplays' }] },
      { id: 'merged', sources: [{ source: 'streamedpk' }, { source: 'myreplays' }] },
      { id: 'other', sources: [{ source: 'streamedpk' }] }
    ];
    const cacheService = { getMatchesReadOnly: () => cached, setMatches: jest.fn() };
    const cronService = { requestSync: jest.fn().mockResolvedValue(undefined) };
    const container = makeContainer({ cronService, cacheService });

    const res = mockRes();
    await routeHandler('/sync', 'post')({ params: {}, app: { get: () => container } }, res);

    expect(cronService.requestSync).toHaveBeenCalledTimes(1);
    expect(provider.getMatches).not.toHaveBeenCalled();
    expect(cacheService.setMatches).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, extracted: 2, pending: false }));
    expect(typeof res.body.message).toBe('string');
  });

  test('POST /:name/sync returns 404 for an unknown parser without syncing', async () => {
    const cronService = { requestSync: jest.fn() };
    const res = mockRes();
    await routeHandler('/:name/sync', 'post')({
      params: { name: 'nope' }, app: { get: () => makeContainer({ cronService }) }
    }, res);
    expect(res.statusCode).toBe(404);
    expect(cronService.requestSync).not.toHaveBeenCalled();
  });

  test('POST /sync reports a failed aggregator sync', async () => {
    dynamicParserRegistry.activeProviders.set('myreplays', { name: 'x', sourceName: 'myreplays' });
    const cronService = { requestSync: jest.fn().mockRejectedValue(new Error('boom')) };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = mockRes();
    await routeHandler('/sync', 'post')({
      params: {}, app: { get: () => makeContainer({ cronService, cacheService: {} }) }
    }, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({ success: false }));
  });
});
