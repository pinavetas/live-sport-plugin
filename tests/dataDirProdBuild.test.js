'use strict';

const path = require('path');
const { getDataDir } = require('../src/dataDir');
const CacheService = require('../src/services/CacheService');

// Runtime-written data must resolve against DATA_DIR or the process working
// directory at runtime. The ncc production bundle rewrites literal
// __dirname / process.cwd() data paths into dist/ assets.
describe('runtime data directory', () => {
  test('defaults to <cwd>/data', () => {
    expect(getDataDir({}, '/srv/app')).toBe(path.join('/srv/app', 'data'));
    expect(getDataDir({ DATA_DIR: '   ' }, '/srv/app')).toBe(path.join('/srv/app', 'data'));
  });

  test('honours DATA_DIR', () => {
    expect(getDataDir({ DATA_DIR: '/var/lib/nuvio' }, '/srv/app')).toBe('/var/lib/nuvio');
  });

  test('matches cache lives in the runtime data dir outside Jest', () => {
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-datadir-'));
    try {
      const file = CacheService.resolveCacheFile({ DATA_DIR: tmp }, '/unused');
      expect(file).toBe(path.join(tmp, 'matches_cache.json'));
      const fallback = CacheService.resolveCacheFile({}, tmp);
      expect(fallback).toBe(path.join(tmp, 'data', 'matches_cache.json'));
      expect(fs.existsSync(path.join(tmp, 'data'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('Jest workers keep their isolated temp cache file', () => {
    const file = CacheService.resolveCacheFile({ JEST_WORKER_ID: '1', DATA_DIR: '/x' }, '/y');
    expect(file).toContain('nuvio-matches-cache-test-');
  });
});
