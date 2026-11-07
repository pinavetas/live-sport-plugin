'use strict';

// syncMatches() stores CLONES of the match set, then enriches team logos in the
// background. The enrichment wrote into the uncloned objects, so the cache
// never saw a single logo. These tests pin that the enriched logos reach the
// cache once the background pass finishes, without blocking the sync.

const fs = require('fs');
const os = require('os');
const path = require('path');
const MatchAggregator = require('../src/services/MatchAggregator');
const CacheService = require('../src/services/CacheService');

function tmpCachePath() {
  return path.join(os.tmpdir(), `logo-enrich-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function channelRow(id, title) {
  return {
    id, title, category: 'networks', date: '0',
    sources: [{ source: 'cdnlive', id: id.replace(/\W/g, '') }]
  };
}

function makeAggregator(cacheService, teamLogoService, rows) {
  const agg = new MatchAggregator({ cacheService, teamLogoService, yamlProviders: [] });
  agg.providers = [{ getMatches: async () => rows.map((r) => JSON.parse(JSON.stringify(r))) }];
  return agg;
}

describe('team logo enrichment reaches the match cache', () => {
  let cachePath;
  let logSpy;

  beforeEach(() => {
    cachePath = tmpCachePath();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    try { fs.unlinkSync(cachePath); } catch (_) {}
  });

  test('logos written by the background pass are visible through the cache', async () => {
    const cache = new CacheService(cachePath);
    let release;
    const gate = new Promise((r) => { release = r; });
    const teamLogoService = {
      enrichMatch: jest.fn(async (m) => {
        await gate;
        m.logo = `https://logos.example.invalid/${m.id}.png`;
        return m;
      })
    };
    const agg = makeAggregator(cache, teamLogoService, [channelRow('ch_sky', 'Sky Sports Main Event')]);

    const result = await agg.syncMatches();
    expect(result.map((m) => m.id)).toContain('ch_sky');
    // The sync returned before enrichment finished: nothing blocked on it.
    expect(cache.findMatch('ch_sky').logo).toBeFalsy();
    const revAfterSync = cache.rev;

    release();
    await expect(agg.logoEnrichment).resolves.toBe(true);

    expect(cache.findMatch('ch_sky').logo).toBe('https://logos.example.invalid/ch_sky.png');
    expect(cache.getMatchesReadOnly().find((m) => m.id === 'ch_sky').logo).toBe('https://logos.example.invalid/ch_sky.png');
    // Catalog page memo is keyed on rev, so it must move.
    expect(cache.rev).toBeGreaterThan(revAfterSync);
    // And the disk snapshot other workers read carries the logo too.
    const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf8')).matches.find((m) => m.id === 'ch_sky');
    expect(onDisk.logo).toBe('https://logos.example.invalid/ch_sky.png');
  });

  test('no write-back when enrichment found nothing', async () => {
    const cache = new CacheService(cachePath);
    const teamLogoService = { enrichMatch: jest.fn(async (m) => m) };
    const agg = makeAggregator(cache, teamLogoService, [channelRow('ch_none', 'Unknown Channel')]);

    await agg.syncMatches();
    const rev = cache.rev;
    await expect(agg.logoEnrichment).resolves.toBe(false);
    expect(cache.rev).toBe(rev);
  });

  test('a newer snapshot is never overwritten by a stale enrichment pass', async () => {
    const cache = new CacheService(cachePath);
    let release;
    const gate = new Promise((r) => { release = r; });
    const teamLogoService = {
      enrichMatch: jest.fn(async (m) => {
        await gate;
        m.logo = 'https://logos.example.invalid/old.png';
        return m;
      })
    };
    const agg = makeAggregator(cache, teamLogoService, [channelRow('ch_old', 'Old Channel Feed')]);

    await agg.syncMatches();
    // A newer sync lands while the first enrichment pass is still running.
    cache.setMatches([channelRow('ch_new', 'New Channel Feed')]);

    release();
    await expect(agg.logoEnrichment).resolves.toBe(false);
    expect(cache.getMatchesReadOnly().map((m) => m.id)).toEqual(['ch_new']);
  });
});
