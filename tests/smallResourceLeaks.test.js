'use strict';

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
// The keep-alive ping goes through the guarded provider transport.
jest.mock('../src/services/ProviderOutbound', () => ({ ...jest.requireActual('../src/services/ProviderOutbound'), request: jest.fn() }));

const cron = require('node-cron');
const providerOutbound = require('../src/services/ProviderOutbound');
const CronService = require('../src/services/CronService');
const IframeDomainRegistry = require('../src/services/IframeDomainRegistry');
const { preprobeManifestSegments } = require('../src/services/HlsRewriteService');
const segmentLengthService = require('../src/services/SegmentLengthService');

describe('CronService keep-alive ping', () => {
  const savedUrl = process.env.RENDER_EXTERNAL_URL;
  let logSpy;

  beforeEach(() => {
    process.env.RENDER_EXTERNAL_URL = 'https://addon.example.invalid';
    cron.schedule.mockReset();
    providerOutbound.request.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // start() also queues the boot-time syncs on timers; keep them from firing.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (savedUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = savedUrl;
    logSpy.mockRestore();
  });

  test('drains the response body so the socket is released', async () => {
    const body = { dump: jest.fn().mockResolvedValue(undefined), destroy: jest.fn() };
    providerOutbound.request.mockResolvedValue({ statusCode: 200, body });

    const svc = new CronService({});
    svc.runSync = jest.fn().mockResolvedValue(undefined);
    svc.start();

    const keepAlive = cron.schedule.mock.calls.find(([expr]) => expr === '*/14 * * * *');
    expect(keepAlive).toBeDefined();
    await keepAlive[1]();

    expect(providerOutbound.request).toHaveBeenCalledWith('https://addon.example.invalid/health');
    expect(body.dump).toHaveBeenCalledTimes(1);
  });
});

describe('preprobeManifestSegments budget timer', () => {
  test('does not leave its 1.5 s timer pending once the probes settle', async () => {
    const probeSpy = jest.spyOn(segmentLengthService, 'probeContentLength').mockResolvedValue(1234);
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const pending = new Set();
    global.setTimeout = (fn, ms, ...args) => {
      const t = realSetTimeout(fn, ms, ...args);
      if (ms === 1500) pending.add(t);
      return t;
    };
    global.clearTimeout = (t) => { pending.delete(t); return realClearTimeout(t); };
    try {
      const m3u8 = [
        '#EXTM3U',
        '#EXTINF:6.000,',
        'https://p16-common-sign.tiktokcdn-us.com/tos/leak_check_seg.image'
      ].join('\n');
      await preprobeManifestSegments(m3u8, 'https://cdn.example.invalid/live/index.m3u8', {});
      expect(probeSpy).toHaveBeenCalled();
      expect(pending.size).toBe(0);
    } finally {
      for (const t of pending) realClearTimeout(t);
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      probeSpy.mockRestore();
    }
  });
});

describe('IframeDomainRegistry runtime learning is bounded', () => {
  test('caps runtime-learned families FIFO and never evicts file-seeded ones', () => {
    const reg = new IframeDomainRegistry();
    const seeded = [...reg.families.entries()].filter(([, r]) => r.source === 'file').map(([k]) => k);
    const cap = IframeDomainRegistry.MAX_RUNTIME_FAMILIES;

    for (let i = 0; i < cap + 50; i++) {
      expect(reg.learn(`learned-${i}.test`, 'direct')).toBe(true);
    }

    const runtime = [...reg.families.values()].filter((r) => r.source === 'runtime');
    expect(runtime.length).toBe(cap);
    expect(reg._learnedStrategies.size).toBe(cap);
    // Oldest entries went first; the newest are kept.
    expect(reg.has('learned-0.test')).toBe(false);
    expect(reg.strategyFor('learned-0.test')).toBeNull();
    expect(reg.has(`learned-${cap + 49}.test`)).toBe(true);
    expect(reg.strategyFor(`learned-${cap + 49}.test`)).toBe('direct');
    for (const slug of seeded) expect(reg.families.has(slug)).toBe(true);
  });
});
