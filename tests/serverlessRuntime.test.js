'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const {
  createColdStartGate, applyServerlessFsDefaults, DATA_ROUTE, CDN_SWR_ROUTE,
  createCdnCachePolicy, createCatalogSnapshot, installSnapshotOnSync, SNAPSHOT_PATH
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

describe('catalog snapshot in Vercel Blob', () => {
  const NOW = 1_800_000_000_000;
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-snap-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Minimal CacheService stand-in that reads the same file format.
  function fakeCache(file) {
    return {
      cacheFilePath: file,
      lastFetchTime: 0,
      matches: [],
      getMatchesReadOnly() { return this.matches; },
      reloadFromDisk() {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.matches = parsed.matches;
        this.lastFetchTime = parsed.timestamp;
        return true;
      }
    };
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

  test('is off without a connected Blob store', async () => {
    const snap = createCatalogSnapshot({ cacheService: fakeCache(path.join(dir, 'm.json')), blob: fakeBlob(), env: {} });
    expect(snap.enabled).toBe(false);
    expect(await snap.loadOnce()).toBe(false);
  });

  test('restores a recent snapshot into the cache file and keeps its timestamp', async () => {
    const file = path.join(dir, 'm.json');
    const cache = fakeCache(file);
    const blob = fakeBlob();
    blob.stored = gz({ schemaVersion: 9, timestamp: NOW - 5 * 60000, matches: [{ id: 'a' }, { id: 'b' }] });
    const snap = createCatalogSnapshot({ cacheService: cache, blob, env: { BLOB_READ_WRITE_TOKEN: 'x' }, now: () => NOW });
    expect(await snap.loadOnce()).toBe(true);
    expect(cache.matches).toHaveLength(2);
    expect(cache.lastFetchTime).toBe(NOW - 5 * 60000);
    expect(blob.get).toHaveBeenCalledWith(SNAPSHOT_PATH, { access: 'private', useCache: false });
    // Once per instance.
    await snap.loadOnce();
    expect(blob.get).toHaveBeenCalledTimes(1);
  });

  test('ignores a snapshot older than the max age', async () => {
    const cache = fakeCache(path.join(dir, 'm.json'));
    const blob = fakeBlob();
    blob.stored = gz({ schemaVersion: 9, timestamp: NOW - 7 * 3600000, matches: [{ id: 'a' }] });
    const snap = createCatalogSnapshot({ cacheService: cache, blob, env: { BLOB_READ_WRITE_TOKEN: 'x' }, now: () => NOW });
    expect(await snap.loadOnce()).toBe(false);
    expect(cache.matches).toHaveLength(0);
  });

  test('uploads the gzipped cache file privately, at most once per interval', async () => {
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 9, timestamp: NOW, matches: [{ id: 'a' }] }));
    const cache = fakeCache(file);
    cache.matches = [{ id: 'a' }];
    cache.lastFetchTime = NOW;
    const blob = fakeBlob();
    const snap = createCatalogSnapshot({ cacheService: cache, blob, env: { BLOB_READ_WRITE_TOKEN: 'x' }, now: () => NOW });

    expect(await snap.save()).toBe('saved');
    const [pathname, body, opts] = blob.put.mock.calls[0];
    expect(pathname).toBe(SNAPSHOT_PATH);
    expect(JSON.parse(zlib.gunzipSync(body)).matches).toEqual([{ id: 'a' }]);
    expect(opts).toMatchObject({ access: 'private', allowOverwrite: true, addRandomSuffix: false });

    cache.lastFetchTime = NOW + 10 * 60000; // a newer sync, but inside the interval
    expect(await snap.save()).toBe('skipped');
    cache.lastFetchTime = NOW + 31 * 60000;
    expect(await snap.save()).toBe('saved');
    expect(blob.put).toHaveBeenCalledTimes(2);
  });

  test('installSnapshotOnSync uploads only after a sync that changed the catalog', async () => {
    const cache = { lastFetchTime: 1 };
    const cronService = { runSync: jest.fn(async () => { cache.lastFetchTime = 2; }) };
    const snapshot = { enabled: true, save: jest.fn(async () => 'saved') };
    installSnapshotOnSync({ cronService, cacheService: cache, snapshot });
    await cronService.runSync();
    expect(snapshot.save).toHaveBeenCalledTimes(1);

    const unchanged = { runSync: jest.fn(async () => {}) };
    installSnapshotOnSync({ cronService: unchanged, cacheService: { lastFetchTime: 5 }, snapshot });
    await unchanged.runSync();
    expect(snapshot.save).toHaveBeenCalledTimes(1);
  });

  test('a cold request uses the snapshot and skips the sync wait', async () => {
    const d = deps();
    const snapshot = {
      enabled: true,
      loadOnce: jest.fn(async () => { d.cacheService.getMatchesReadOnly.mockReturnValue([{ id: 'x' }]); return true; })
    };
    const next = jest.fn();
    await createColdStartGate({ ...d, snapshot })({ path: '/catalog/Sports/a.json' }, fakeRes(), next);
    expect(snapshot.loadOnce).toHaveBeenCalledTimes(1);
    expect(d.cronService.syncNow).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a cold request falls back to the sync when there is no snapshot', async () => {
    const d = deps();
    const snapshot = { enabled: true, loadOnce: jest.fn(async () => false) };
    const next = jest.fn();
    await createColdStartGate({ ...d, snapshot })({ path: '/catalog/Sports/a.json' }, fakeRes(), next);
    expect(d.cronService.syncNow).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
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
