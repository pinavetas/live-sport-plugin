'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createColdStartGate, applyServerlessFsDefaults, DATA_ROUTE } = require('../src/serverless');

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
