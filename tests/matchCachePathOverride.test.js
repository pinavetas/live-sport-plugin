const fs = require('fs');
const os = require('os');
const path = require('path');

const CacheService = require('../src/services/CacheService');

// The catalog cache path is load-bearing and build-dependent: ncc rewrites
// path.join(process.cwd(), 'data') inside the bundle and drops the 'data'
// segment, so dist/matches_cache.json becomes the live file no matter what the
// source says. MATCHES_CACHE_PATH is the only external control, so pin its
// precedence here.
describe('MATCHES_CACHE_PATH override', () => {
  const originalOverride = process.env.MATCHES_CACHE_PATH;
  const originalWorkerId = process.env.JEST_WORKER_ID;
  let directory;

  function restore(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-cache-override-'));
  });

  afterEach(() => {
    restore('MATCHES_CACHE_PATH', originalOverride);
    restore('JEST_WORKER_ID', originalWorkerId);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('an explicit override replaces the default data/ path', () => {
    delete process.env.JEST_WORKER_ID;
    const target = path.join(directory, 'live', 'matches_cache.json');
    process.env.MATCHES_CACHE_PATH = target;

    expect(new CacheService().cacheFilePath).toBe(target);
  });

  test('the override is normalised, so a relative value cannot hide behind a trailing separator', () => {
    delete process.env.JEST_WORKER_ID;
    process.env.MATCHES_CACHE_PATH = `${directory}${path.sep}live${path.sep}matches_cache.json${path.sep}`;

    expect(new CacheService().cacheFilePath).toBe(path.join(directory, 'live', 'matches_cache.json'));
  });

  test('jest worker isolation wins over the override, so a shell variable cannot unisolate the suite', () => {
    process.env.JEST_WORKER_ID = '1';
    const shared = path.join(directory, 'shared.json');
    process.env.MATCHES_CACHE_PATH = shared;

    const resolved = new CacheService().cacheFilePath;
    expect(resolved).toContain('nuvio-matches-cache-test-');
    expect(resolved).not.toBe(shared);
  });

  test('setMatches writes to the override path and creates the directory it needs', () => {
    delete process.env.JEST_WORKER_ID;
    const target = path.join(directory, 'nested', 'deeper', 'matches_cache.json');
    process.env.MATCHES_CACHE_PATH = target;

    new CacheService().setMatches([{ id: 'override-fixture', title: 'Alpha vs Beta', sources: [] }]);

    expect(fs.existsSync(target)).toBe(true);
    const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(written.matches.map((m) => m.id)).toEqual(['override-fixture']);
  });
});
