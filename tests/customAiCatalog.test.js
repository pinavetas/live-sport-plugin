'use strict';

const container = require('../src/container');
const MatchEntity = require('../src/domain/MatchEntity');
const { manifest } = require('../src/manifest');
const {
  handleCatalog,
  isCustomAiMatch,
  mapMatchToMetaPreview
} = require('../src/catalog');
const dynamicParserRegistry = require('../src/services/DynamicParserRegistry');

describe('Custom IA Games Catalog (nuvio_sports_custom_ai)', () => {
  let cacheService;

  beforeAll(() => {
    cacheService = container.resolve('cacheService');
  });

  test('manifest registers nuvio_sports_custom_ai catalog with correct name and genre options', () => {
    const catalog = manifest.catalogs.find(c => c.id === 'nuvio_sports_custom_ai');
    expect(catalog).toBeDefined();
    expect(catalog.type).toBe('tv');
    expect(catalog.name).toBe('🤖 Custom IA Games');

    const genreExtra = catalog.extra.find(e => e.name === 'genre');
    expect(genreExtra).toBeDefined();
    expect(genreExtra.options).toContain('Football');
    expect(genreExtra.options).toContain('Basketball');
    expect(genreExtra.options).toContain('All');

    const searchExtra = catalog.extra.find(e => e.name === 'search');
    expect(searchExtra).toBeDefined();
  });

  test('isCustomAiMatch accurately detects matches originated from custom AI parsers', () => {
    // 1. Explicit isCustomAi flag
    const matchFlag = new MatchEntity({
      id: 'custom_1',
      title: 'Real Madrid vs Barcelona',
      category: 'football',
      isCustomAi: true,
      sources: [{ source: 'custom_source', id: 'http://test.com/stream' }]
    });
    expect(isCustomAiMatch(matchFlag)).toBe(true);

    // 2. CustomAiSource attribute
    const matchSourceAttr = new MatchEntity({
      id: 'custom_2',
      title: 'Lakers vs Warriors',
      category: 'basketball',
      customAiSource: 'nbaparser',
      sources: [{ source: 'nbaparser', id: 'http://test.com/stream2' }]
    });
    expect(isCustomAiMatch(matchSourceAttr)).toBe(true);

    // 3. Regular non-AI match
    const regularMatch = new MatchEntity({
      id: 'daddylive_123',
      title: 'Arsenal vs Chelsea',
      category: 'football',
      sources: [{ source: 'daddylive', id: 'stream_1' }]
    });
    expect(isCustomAiMatch(regularMatch)).toBe(false);
  });

  test('mapMatchToMetaPreview adds 🤖 prefix and CUSTOM IA genre for custom AI matches', () => {
    const aiLiveMatch = new MatchEntity({
      id: 'custom_live_1',
      title: 'Liverpool vs Manchester City',
      category: 'football',
      date: (Date.now() - 30 * 60 * 1000).toString(), // 30 mins ago = Live
      isCustomAi: true,
      customAiSource: 'soccerstreamer',
      sources: [{ source: 'soccerstreamer', id: 'http://example.com/stream' }]
    });

    const meta = mapMatchToMetaPreview(aiLiveMatch, {}, 'tv');
    expect(meta.name).toContain('🤖');
    expect(meta.name).toContain('Liverpool vs Manchester City');
    expect(meta.genres).toContain('CUSTOM IA');
    expect(meta.genres).toContain('FOOTBALL');
    expect(meta.description).toContain('Custom IA Parser');
  });

  test('handleCatalog returns custom AI matches for nuvio_sports_custom_ai', async () => {
    const customMatch1 = new MatchEntity({
      id: 'custom_fb_1',
      title: 'Bayern vs Dortmund',
      category: 'football',
      date: Date.now().toString(),
      isCustomAi: true,
      sources: [{ source: 'mysoccer', id: 's1' }]
    });

    const customMatch2 = new MatchEntity({
      id: 'custom_bb_1',
      title: 'Celtics vs Knicks',
      category: 'basketball',
      date: Date.now().toString(),
      isCustomAi: true,
      sources: [{ source: 'myhoops', id: 's2' }]
    });

    const regularMatch = new MatchEntity({
      id: 'regular_1',
      title: 'PSG vs Marseille',
      category: 'football',
      date: Date.now().toString(),
      sources: [{ source: 'streamedpk', id: 's3' }]
    });

    cacheService.setMatches([customMatch1, customMatch2, regularMatch]);

    // Query whole custom_ai catalog
    const result = await handleCatalog('tv', 'nuvio_sports_custom_ai', {}, {});
    expect(result).toBeDefined();
    expect(Array.isArray(result.metas)).toBe(true);

    const metaIds = result.metas.map(m => m.id);
    expect(metaIds).toContain('nuvio_sport_custom_fb_1');
    expect(metaIds).toContain('nuvio_sport_custom_bb_1');
    expect(metaIds).not.toContain('nuvio_sport_regular_1');

    // Query with genre filter
    const fbOnly = await handleCatalog('tv', 'nuvio_sports_custom_ai', { genre: 'Football' }, {});
    const fbIds = fbOnly.metas.map(m => m.id);
    expect(fbIds).toContain('nuvio_sport_custom_fb_1');
    expect(fbIds).not.toContain('nuvio_sport_custom_bb_1');

    // Query with search filter
    const searchResult = await handleCatalog('tv', 'nuvio_sports_custom_ai', { search: 'Knicks' }, {});
    const searchIds = searchResult.metas.map(m => m.id);
    expect(searchIds).toContain('nuvio_sport_custom_bb_1');
    expect(searchIds).not.toContain('nuvio_sport_custom_fb_1');
  });
});
