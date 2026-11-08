'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DynamicParserRegistry, resolveDefaultStoragePath } = require('../src/services/DynamicParserRegistry');

// The parser storage must live in the runtime data dir (DATA_DIR or
// <cwd>/data), never next to the module: the ncc production bundle rewrites
// __dirname-relative paths into dist/ assets that every build wipes.
describe('DynamicParserRegistry storage location', () => {
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-storage-'));
  });

  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('defaults to <cwd>/data/custom_parsers.json', () => {
    expect(resolveDefaultStoragePath({}, '/srv/app'))
      .toBe(path.join('/srv/app', 'data', 'custom_parsers.json'));
    expect(resolveDefaultStoragePath({ DATA_DIR: '   ' }, '/srv/app'))
      .toBe(path.join('/srv/app', 'data', 'custom_parsers.json'));
  });

  test('uses the process working directory, not the module directory', () => {
    delete process.env.DATA_DIR;
    const registry = new DynamicParserRegistry();
    expect(registry.storagePath).toBe(path.join(process.cwd(), 'data', 'custom_parsers.json'));
  });

  test('DATA_DIR overrides the default and saved parsers are written there', () => {
    process.env.DATA_DIR = tmpDir;
    const registry = new DynamicParserRegistry();
    expect(registry.storagePath).toBe(path.join(tmpDir, 'custom_parsers.json'));

    registry.saveParser({
      name: 'My Replays',
      baseUrl: 'https://example.com/replays',
      selectors: { matches: '.item', title: 'h2', link: 'a' }
    }, null);

    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'custom_parsers.json'), 'utf8'));
    expect(stored.map(p => p.name)).toEqual(['myreplays']);
    expect(new DynamicParserRegistry().listParsers().map(p => p.name)).toEqual(['myreplays']);
  });

  test('explicit storagePath option still wins over DATA_DIR', () => {
    process.env.DATA_DIR = tmpDir;
    const explicit = path.join(tmpDir, 'nested', 'parsers.json');
    expect(new DynamicParserRegistry({ storagePath: explicit }).storagePath).toBe(explicit);
  });
});
