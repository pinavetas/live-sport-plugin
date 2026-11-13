'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const {
  createColdStartGate, applyServerlessFsDefaults, DATA_ROUTE, CDN_SWR_ROUTE,
  createCdnCachePolicy, createSharedCatalog, installSharedCatalog, SNAPSHOT_PATH, RUNTIME_KEYS
} = require('../src/serverless');

function fakeRes() {
  return new EventEmitter();
}

function deps({ matches = [], sync = Promise.resolve() } = {}) {
  const cronService = { syncNow: jest.fn(() => sync), inflightSync: null };
  const cacheService = { getMatchesReadOnly: jest.fn(() => matches) };
  return { cronService, cacheService };
}

describe('serverless cold-start gate', () => {
  test('matches only addon data routes, with or without a config segment', () => {
    for (const p of ['/catalog/Sports/x.json', '/eyJ0/catalog/Sports/x.json', '/meta/Sports/a.json', '/cfg/stream/tv/b.json']) {
      expect(DATA_ROUTE.test(p)).toBe(true);
    }
    for (const p of ['/', '/live', '/manifest.json', '/api/provider-health', '/img/match', '/watch']) {
      expect(DATA_ROUTE.test(p)).toBe(false);
    }
  });

  test('non-data routes pass straight through without syncing', async () => {
    const d = deps();
    const next = jest.fn();
    await createColdStartGate(d)({ path: '/manifest.json' }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(d.cronService.syncNow).not.toHaveBeenCalled();
  });

  test('a warm catalog does not trigger a sync', async () => {
    const d = deps({ matches: [{ id: 'm1' }] });
    const next = jest.fn();
    await createColdStartGate(d)({ path: '/catalog/Sports/nuvio_sports_live.json' }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(d.cronService.syncNow).not.toHaveBeenCalled();
  });

  test('an empty catalog waits for the first sync before continuing', async () => {
    let finish;
    const sync = new Promise((r) => { finish = r; });
    const d = deps({ sync });
    const next = jest.fn();
    const done = createColdStartGate(d)({ path: '/catalog/Sports/nuvio_sports_live.json' }, fakeRes(), next);
    await new Promise((r) => setImmediate(r));
    expect(d.cronService.syncNow).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    finish();
    await done;
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('the wait is bounded when the sync hangs', async () => {
    const d = deps({ sync: new Promise(() => {}) });
    const next = jest.fn();
    const started = Date.now();
    await createColdStartGate({ ...d, maxWaitMs: 30 })({ path: '/stream/Sports/a.json' }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('CDN stale-while-revalidate policy', () => {
  test('covers catalog, meta and manifest but not streams', () => {
    for (const p of ['/catalog/Sports/x.json', '/cfg/catalog/tv/y/skip=100.json', '/meta/tv/a.json', '/manifest.json', '/cfg/manifest.json']) {
      expect(CDN_SWR_ROUTE.test(p)).toBe(true);
    }
    for (const p of ['/stream/Sports/a.json', '/cfg/stream/tv/b.json', '/', '/live', '/api/manifest.m3u8']) {
      expect(CDN_SWR_ROUTE.test(p)).toBe(false);
    }
  });

  async function respond(path, headers, status = 200) {
    const server = http.createServer((req, res) => {
      createCdnCachePolicy({ swrSeconds: 600 })(req, res, () => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.statusCode = status;
        res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const got = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); res.on('end', () => resolve(res.headers)); }).on('error', reject);
    });
    await new Promise((r) => server.close(r));
    return got;
  }

  test('reuses the public max-age and adds stale-while-revalidate', async () => {
    const h = await respond('/catalog/Sports/nuvio_sports_live.json', { 'Cache-Control': 'max-age=120, public' });
    expect(h['vercel-cdn-cache-control']).toBe('max-age=120, stale-while-revalidate=600');
    expect(h['cache-control']).toBe('max-age=120, public');
  });

  test('leaves private, no-store, error and stream responses alone', async () => {
    expect((await respond('/catalog/a/b.json', { 'Cache-Control': 'private, max-age=60' }))['vercel-cdn-cache-control']).toBeUndefined();
    expect((await respond('/catalog/a/b.json', { 'Cache-Control': 'no-store' }))['vercel-cdn-cache-control']).toBeUndefined();
    expect((await respond('/catalog/a/b.json', { 'Cache-Control': 'max-age=60, public' }, 500))['vercel-cdn-cache-control']).toBeUndefined();
    expect((await respond('/stream/a/b.json', { 'Cache-Control': 'max-age=60, public' }))['vercel-cdn-cache-control']).toBeUndefined();
  });
});

describe('shared catalog (Runtime Cache + Blob)', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60000;
  let dir;
  let clock;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-shared-'));
    clock = { t: NOW };
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const now = () => clock.t;
  const noSleep = () => Promise.resolve();

  // Minimal CacheService stand-in that reads the same file format.
  function fakeCache(name = 'm.json') {
    const file = path.join(dir, name);
    return {
      cacheFilePath: file,
      lastFetchTime: 0,
      matches: [],
      getMatchesReadOnly() { return this.matches; },
      isStale(ms) { return clock.t - this.lastFetchTime > ms; },
      reloadFromDisk() {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.matches = parsed.matches;
        this.lastFetchTime = parsed.timestamp;
        return true;
      }
    };
  }
  // A sync writes the cache file stamped with the current clock.
  function fakeCron(cache, matches = [{ id: 'synced' }]) {
    const cron = {
      inflightSync: null,
      syncBackoffUntil: 0,
      runSync: jest.fn(async () => {
        fs.writeFileSync(cache.cacheFilePath, JSON.stringify({ schemaVersion: 9, timestamp: clock.t, matches }));
        cache.reloadFromDisk();
      })
    };
    cron.syncNow = jest.fn(() => cron.runSync());
    return cron;
  }
  // Same semantics as @vercel/functions' in-memory cache: values go through JSON.
  function fakeRuntime() {
    const map = new Map();
    return {
      map,
      get: jest.fn(async (k) => (map.has(k) ? JSON.parse(map.get(k)) : null)),
      set: jest.fn(async (k, v) => { map.set(k, JSON.stringify(v)); }),
      delete: jest.fn(async (k) => { map.delete(k); })
    };
  }
  // A Runtime Cache that keeps nothing (unavailable, or paused on quota).
  function deadRuntime() {
    return { get: jest.fn(async () => null), set: jest.fn(async () => {}), delete: jest.fn(async () => {}) };
  }
  function fakeBlob() {
    const store = { stored: null };
    store.put = jest.fn(async (pathname, body, opts) => { store.stored = body; return { pathname, opts }; });
    store.get = jest.fn(async () => (store.stored
      ? { statusCode: 200, stream: new Blob([store.stored]).stream() }
      : null));
    return store;
  }
  const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const BLOB_ENV = { BLOB_READ_WRITE_TOKEN: 'x' };

  function instance({ runtime, blob = fakeBlob(), env = BLOB_ENV, id = 'a', matches } = {}) {
    const cache = fakeCache(`${id}.json`);
    const cron = fakeCron(cache, matches);
    const shared = createSharedCatalog({
      cacheService: cache, cronService: cron, runtimeCache: runtime, blob, env, now, sleep: noSleep, instanceId: id
    });
    return { cache, cron, shared, blob };
  }

  // Publishes a catalog stamped `ts` as another instance would.
  async function seed(runtime, ts, matches = [{ id: 'shared' }]) {
    const data = { timestamp: ts, gz: gz({ schemaVersion: 9, timestamp: ts, matches }).toString('base64') };
    runtime.map.set(RUNTIME_KEYS.DATA_KEY, JSON.stringify(data));
    runtime.map.set(RUNTIME_KEYS.META_KEY, JSON.stringify({ timestamp: ts, blobSavedAt: ts, by: 'other' }));
  }
  const leaseOf = (runtime) => {
    const raw = runtime.map.get(RUNTIME_KEYS.LEASE_KEY);
    return raw ? JSON.parse(raw) : null;
  };
  const setLease = (runtime, lease) => runtime.map.set(RUNTIME_KEYS.LEASE_KEY, JSON.stringify(lease));

  test('a cold instance adopts the runtime-cache catalog without touching Blob', async () => {
    const runtime = fakeRuntime();
    await seed(runtime, NOW - 5 * MIN, [{ id: 'a' }, { id: 'b' }]);
    const { cache, shared, blob } = instance({ runtime });
    expect(await shared.restoreCold()).toBe(true);
    expect(cache.matches).toHaveLength(2);
    expect(cache.lastFetchTime).toBe(NOW - 5 * MIN);
    expect(blob.get).not.toHaveBeenCalled();
  });

  test('falls back to Blob once per instance and seeds the runtime cache from it', async () => {
    const runtime = fakeRuntime();
    const blob = fakeBlob();
    blob.stored = gz({ schemaVersion: 9, timestamp: NOW - 30 * MIN, matches: [{ id: 'a' }] });
    const { cache, shared } = instance({ runtime, blob });
    expect(await shared.restoreCold()).toBe(true);
    expect(cache.matches).toEqual([{ id: 'a' }]);
    expect(blob.get).toHaveBeenCalledWith(SNAPSHOT_PATH, { access: 'private', useCache: false });
    expect((await runtime.get(RUNTIME_KEYS.META_KEY)).timestamp).toBe(NOW - 30 * MIN);

    const empty = instance({ runtime: fakeRuntime(), blob: fakeBlob(), id: 'b' });
    await empty.shared.restoreCold();
    await empty.shared.restoreCold();
    expect(empty.blob.get).toHaveBeenCalledTimes(1);
  });

  test('ignores a shared catalog older than the max age', async () => {
    const runtime = fakeRuntime();
    await seed(runtime, NOW - 7 * 60 * MIN);
    const { cache, shared } = instance({ runtime, env: {} });
    expect(await shared.restoreCold()).toBe(false);
    expect(cache.matches).toHaveLength(0);
  });

  test('publish shares every sync but uploads to Blob at most once per interval across instances', async () => {
    const runtime = fakeRuntime();
    const blob = fakeBlob();
    const a = instance({ runtime, blob, id: 'a' });
    await a.cron.runSync();
    expect(await a.shared.publish()).toBe('shared+blob');
    const [pathname, body, opts] = blob.put.mock.calls[0];
    expect(pathname).toBe(SNAPSHOT_PATH);
    expect(JSON.parse(zlib.gunzipSync(body)).matches).toEqual([{ id: 'synced' }]);
    expect(opts).toMatchObject({ access: 'private', allowOverwrite: true, addRandomSuffix: false });

    clock.t += 25 * MIN;
    const b = instance({ runtime, blob, id: 'b' });
    await b.cron.runSync();
    expect(await b.shared.publish()).toBe('shared');
    expect(blob.put).toHaveBeenCalledTimes(1);
    expect((await runtime.get(RUNTIME_KEYS.META_KEY)).timestamp).toBe(NOW + 25 * MIN);

    clock.t += 2 * 60 * MIN;
    await b.cron.runSync();
    expect(await b.shared.publish()).toBe('shared+blob');
    expect(blob.put).toHaveBeenCalledTimes(2);
  });

  test('without a working runtime cache, Blob uploads are still throttled per instance', async () => {
    const blob = fakeBlob();
    const { cron, shared } = instance({ runtime: deadRuntime(), blob });
    await cron.runSync();
    expect(await shared.publish()).toBe('shared+blob');
    clock.t += 25 * MIN;
    await cron.runSync();
    expect(await shared.publish()).toBe('failed');
    expect(blob.put).toHaveBeenCalledTimes(1);
  });

  test('a stale instance adopts a newer shared catalog instead of syncing', async () => {
    const runtime = fakeRuntime();
    const { cache, cron, shared } = instance({ runtime });
    await cron.runSync(); // local catalog from NOW
    cron.syncNow.mockClear();
    clock.t += 25 * MIN;
    await seed(runtime, clock.t - 2 * MIN);
    expect(await shared.refresh()).toBe('pulled');
    expect(cache.lastFetchTime).toBe(clock.t - 2 * MIN);
    expect(cron.syncNow).not.toHaveBeenCalled();
  });

  test('when the shared catalog is stale too, only the lease holder syncs', async () => {
    const runtime = fakeRuntime();
    const holder = instance({ runtime, id: 'holder' });
    const other = instance({ runtime, id: 'other' });
    clock.t += 25 * MIN; // both catalogs are empty, hence stale
    setLease(runtime, { holder: 'holder', until: clock.t + 60000 });

    expect(await other.shared.refresh()).toBe('leased-elsewhere');
    expect(other.cron.syncNow).not.toHaveBeenCalled();

    expect(await holder.shared.refresh()).toBe('synced');
    expect(holder.cron.syncNow).toHaveBeenCalledTimes(1);
    expect(leaseOf(runtime)).toBeNull(); // released
  });

  test('an expired lease no longer blocks a sync', async () => {
    const runtime = fakeRuntime();
    const { cron, shared } = instance({ runtime, id: 'b' });
    clock.t += 25 * MIN;
    setLease(runtime, { holder: 'dead', until: clock.t - 1 });
    expect(await shared.refresh()).toBe('synced');
    expect(cron.syncNow).toHaveBeenCalledTimes(1);
  });

  test('two instances racing for the lease: exactly one wins', async () => {
    const runtime = fakeRuntime();
    const a = instance({ runtime, id: 'a' });
    const b = instance({ runtime, id: 'b' });
    const won = await Promise.all([a.shared.tryAcquireLease(), b.shared.tryAcquireLease()]);
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  test('fresh catalogs, recent checks and running syncs do not touch the shared cache', async () => {
    const runtime = fakeRuntime();
    const { cron, shared } = instance({ runtime });
    await cron.runSync();
    runtime.get.mockClear();
    expect(await shared.refresh()).toBe('fresh');
    expect(runtime.get).not.toHaveBeenCalled();

    clock.t += 25 * MIN;
    setLease(runtime, { holder: 'other', until: clock.t + 60000 });
    expect(await shared.refresh()).toBe('leased-elsewhere');
    expect(await shared.refresh()).toBe('throttled');

    clock.t += 2 * MIN;
    cron.inflightSync = Promise.resolve();
    expect(await shared.refresh()).toBe('syncing');
  });

  test('fails open: with no working runtime cache every instance syncs on its own', async () => {
    const { cron, shared } = instance({ runtime: deadRuntime(), env: {} });
    clock.t += 25 * MIN;
    expect(await shared.refresh()).toBe('synced');
    expect(cron.syncNow).toHaveBeenCalledTimes(1);
  });

  test('installSharedCatalog publishes before the sync counts as done, and routes ensureFresh', async () => {
    const cache = { lastFetchTime: 1 };
    const order = [];
    const cronService = {
      runSync: jest.fn(async () => { cache.lastFetchTime = 2; order.push('sync'); }),
      ensureFresh: jest.fn()
    };
    const shared = {
      publish: jest.fn(async () => { order.push('publish'); return 'shared'; }),
      refresh: jest.fn(async () => 'fresh')
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      installSharedCatalog({ cronService, cacheService: cache, shared });
      await cronService.runSync();
      order.push('done');
    } finally {
      log.mockRestore();
    }
    expect(order).toEqual(['sync', 'publish', 'done']);

    cronService.ensureFresh();
    expect(shared.refresh).toHaveBeenCalledTimes(1);

    cache.lastFetchTime = 5;
    const unchanged = { runSync: jest.fn(async () => {}) };
    installSharedCatalog({ cronService: unchanged, cacheService: cache, shared });
    await unchanged.runSync();
    expect(shared.publish).toHaveBeenCalledTimes(1);
  });

  test('a cold request uses the shared catalog and skips the sync', async () => {
    const d = deps();
    const shared = {
      restoreCold: jest.fn(async () => { d.cacheService.getMatchesReadOnly.mockReturnValue([{ id: 'x' }]); return true; }),
      syncOrWait: jest.fn()
    };
    const next = jest.fn();
    await createColdStartGate({ ...d, shared })({ path: '/catalog/Sports/a.json' }, fakeRes(), next);
    expect(shared.restoreCold).toHaveBeenCalledTimes(1);
    expect(shared.syncOrWait).not.toHaveBeenCalled();
    expect(d.cronService.syncNow).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a cold request with nothing shared syncs or waits for the lease holder', async () => {
    const d = deps();
    const shared = { restoreCold: jest.fn(async () => false), syncOrWait: jest.fn(async () => 'synced') };
    const next = jest.fn();
    await createColdStartGate({ ...d, shared })({ path: '/catalog/Sports/a.json' }, fakeRes(), next);
    expect(shared.syncOrWait).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('syncOrWait: a cold instance waits for the holder result instead of syncing', async () => {
    const runtime = fakeRuntime();
    const { cache, cron, shared } = instance({ runtime, id: 'waiter' });
    setLease(runtime, { holder: 'holder', until: NOW + 60000 });
    let metaReads = 0;
    // The holder publishes while the waiter polls.
    runtime.get.mockImplementation(async (k) => {
      if (k === RUNTIME_KEYS.META_KEY && ++metaReads === 2) await seed(runtime, NOW);
      return runtime.map.has(k) ? JSON.parse(runtime.map.get(k)) : null;
    });
    expect(await shared.syncOrWait(NOW + 1)).toBe('pulled');
    expect(cron.syncNow).not.toHaveBeenCalled();
    expect(cache.matches).toEqual([{ id: 'shared' }]);
  });

  test('syncOrWait: the lease holder syncs', async () => {
    const runtime = fakeRuntime();
    const { cron, shared } = instance({ runtime, id: 'first' });
    expect(await shared.syncOrWait(NOW + 1)).toBe('synced');
    expect(cron.syncNow).toHaveBeenCalledTimes(1);
  });
});

describe('serverless filesystem defaults', () => {
  test('points every writable file at the serverless data dir', () => {
    const env = applyServerlessFsDefaults({ SERVERLESS_DATA_DIR: '/tmp/x' });
    expect(env.DATA_DIR).toBe('/tmp/x');
    expect(env.LIVE_OVERLAY_FILE).toBe('/tmp/x/live_overlay.json');
    expect(env.TEAM_LOGOS_CACHE_FILE).toBe('/tmp/x/team_logos_cache.json');
  });

  test('explicit values win', () => {
    const env = applyServerlessFsDefaults({ DATA_DIR: '/data', LIVE_OVERLAY_FILE: '/o.json' });
    expect(env.DATA_DIR).toBe('/data');
    expect(env.LIVE_OVERLAY_FILE).toBe('/o.json');
    expect(env.TEAM_LOGOS_CACHE_FILE).toBe('/tmp/live-sports/team_logos_cache.json');
  });
});

describe('Vercel wiring', () => {
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

  test('index.js exports the app instead of listening when running on Vercel', () => {
    expect(index).toMatch(/if \(IS_SERVERLESS\) \{\s*module\.exports = app;\s*\} else \{\s*startServer\(\);/);
    expect(index).toMatch(/function startServer\(\) \{[\s\S]*cronService'\)\.start\(\)[\s\S]*app\.listen\(/);
  });

  test('vercel.json routes everything to the function and ships src + public with it', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    expect(cfg.rewrites).toEqual([{ source: '/(.*)', destination: '/api/index' }]);
    expect(cfg.functions['api/index.js'].includeFiles).toBe('{src,public}/**');
    expect(cfg.outputDirectory).toBe('public');
  });

  test('the configured base URL prefers the Vercel production domain', () => {
    const saved = process.env;
    process.env = { ...saved, VERCEL_PROJECT_PRODUCTION_URL: 'live-sports.example.vercel.app', VERCEL_URL: 'live-sports-abc123.vercel.app' };
    delete process.env.ADDON_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.WEBSITE_HOSTNAME;
    let config;
    try {
      jest.isolateModules(() => { config = require('../src/config'); });
    } finally {
      process.env = saved;
    }
    expect(config.BASE_URL).toBe('https://live-sports.example.vercel.app');
  });
});
