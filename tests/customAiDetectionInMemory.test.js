'use strict';

const fs = require('fs');
const MatchEntity = require('../src/domain/MatchEntity');
const { handleCatalog, isCustomAiMatch, hasCustomAiContent } = require('../src/catalog');
const container = require('../src/container');
const dynamicParserRegistry = require('../src/services/DynamicParserRegistry');

// Custom-AI detection runs per match over the whole cache (manifest handler and
// the custom_ai catalog). It must stay in memory: reading the parser storage
// file per match blocked the event loop for ~0.3s on a ~10k-match cache.
describe('custom-AI detection is in-memory only', () => {
  const regular = (i) => new MatchEntity({
    id: `streamedpk_${i}`,
    title: `Team ${i} vs Team ${i + 1}`,
    category: 'football',
    sources: [{ source: 'streamedpk', id: `s${i}` }]
  });

  let listSpy;
  let readSpy;
  let existsSpy;

  beforeEach(() => {
    dynamicParserRegistry.activeProviders.clear();
    listSpy = jest.spyOn(dynamicParserRegistry, 'listParsers');
    readSpy = jest.spyOn(fs, 'readFileSync');
    existsSpy = jest.spyOn(fs, 'existsSync');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    dynamicParserRegistry.activeProviders.clear();
  });

  test('never reads the parser registry storage while classifying matches', () => {
    const matches = Array.from({ length: 500 }, (_, i) => regular(i));
    for (const m of matches) expect(isCustomAiMatch(m)).toBe(false);
    expect(hasCustomAiContent(matches)).toBe(false);

    expect(listSpy).not.toHaveBeenCalled();
    const touchedStorage = (spy) => spy.mock.calls.some(([p]) => String(p).includes('custom_parsers'));
    expect(touchedStorage(readSpy)).toBe(false);
    expect(touchedStorage(existsSpy)).toBe(false);
  });

  test('detects matches of an active provider by source name and id prefix', () => {
    dynamicParserRegistry.activeProviders.set('myreplays', { sourceName: 'myreplays' });

    const bySource = new MatchEntity({
      id: 'whatever_1', title: 'A vs B', category: 'football',
      sources: [{ source: 'myreplays', id: 'http://x/1' }]
    });
    const byIdPrefix = new MatchEntity({
      id: 'myreplays_abc', title: 'C vs D', category: 'football',
      sources: [{ source: 'other', id: 'http://x/2' }]
    });
    expect(isCustomAiMatch(bySource)).toBe(true);
    expect(isCustomAiMatch(byIdPrefix)).toBe(true);
    expect(isCustomAiMatch(regular(1))).toBe(false);
    expect(listSpy).not.toHaveBeenCalled();
  });

  test('flagged matches are detected even without active providers', () => {
    const flagged = new MatchEntity({
      id: 'x_1', title: 'E vs F', category: 'football', isCustomAi: true,
      sources: [{ source: 'gone', id: 'u' }]
    });
    const bySourceAttr = new MatchEntity({
      id: 'x_2', title: 'G vs H', category: 'football', customAiSource: 'gone',
      sources: [{ source: 'gone', id: 'u2' }]
    });
    expect(isCustomAiMatch(flagged)).toBe(true);
    expect(isCustomAiMatch(bySourceAttr)).toBe(true);
    expect(hasCustomAiContent([regular(1), flagged])).toBe(true);
  });

  test('hasCustomAiContent is true as soon as a provider is mounted, without scanning', () => {
    dynamicParserRegistry.activeProviders.set('myreplays', { sourceName: 'myreplays' });
    expect(hasCustomAiContent([])).toBe(true);
    expect(listSpy).not.toHaveBeenCalled();
  });

  test('custom_ai catalog filter does not read the registry storage', async () => {
    dynamicParserRegistry.activeProviders.set('myreplays', { sourceName: 'myreplays' });
    const cacheService = container.resolve('cacheService');
    const custom = new MatchEntity({
      id: 'myreplays_1', title: 'Real vs Atleti', category: 'football',
      date: Date.now().toString(),
      sources: [{ source: 'myreplays', id: 'http://x/1' }]
    });
    cacheService.setMatches([custom, ...Array.from({ length: 50 }, (_, i) => regular(i))]);

    const result = await handleCatalog('tv', 'nuvio_sports_custom_ai', {}, {});
    const ids = result.metas.map(m => m.id);
    expect(ids).toContain('nuvio_sport_myreplays_1');
    expect(ids).not.toContain('nuvio_sport_streamedpk_1');
    expect(listSpy).not.toHaveBeenCalled();
  });
});
