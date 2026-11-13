'use strict';

// Matches are served under a custom "Sports" type (its own section in the
// client); 24/7 networks stay under the standard "tv" type.

const { manifest } = require('../src/manifest');
const { SPORTS_TYPE, isSupportedType } = require('../src/contentTypes');

describe('manifest content types', () => {
  test('declares the Sports type first and keeps tv/series/channel', () => {
    expect(manifest.types).toEqual([SPORTS_TYPE, 'tv', 'series', 'channel']);
  });

  test('every match catalog is Sports; only 24/7 networks are tv', () => {
    for (const c of manifest.catalogs) {
      expect(c.type).toBe(c.id === 'nuvio_sports_networks' ? 'tv' : SPORTS_TYPE);
    }
  });

  test('Live Now leads, followed by Upcoming', () => {
    const ids = manifest.catalogs.map(c => c.id);
    expect(ids[0]).toBe('nuvio_sports_live');
    expect(ids[1]).toBe('nuvio_sports_upcoming');
    expect(ids.indexOf('nuvio_sports_football')).toBeGreaterThan(ids.indexOf('nuvio_sports_upcoming'));
  });

  test('no custom-AI catalog remains', () => {
    expect(manifest.catalogs.some(c => /custom_ai/.test(c.id))).toBe(false);
  });
});

describe('handlers accept the Sports type', () => {
  test('isSupportedType', () => {
    for (const t of [SPORTS_TYPE, 'tv', 'series', 'channel']) expect(isSupportedType(t)).toBe(true);
    for (const t of ['movie', 'sports', '', undefined]) expect(isSupportedType(t)).toBe(false);
  });

  test('catalog metas carry the requested Sports type, so meta/stream requests use it too', async () => {
    const container = require('../src/container');
    container.resolve('matchAggregator').syncMatches = async () => [];
    container.resolve('cronService').syncing = true;
    container.resolve('cacheService').setMatches([{
      id: 'sports_type_fixture', title: 'Alpha vs Beta', category: 'football', status: 'live',
      date: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      sources: [{ source: 'daddylive', id: 'x' }],
    }]);
    const { handleCatalog, handleMeta } = require('../src/catalog');

    const cat = await handleCatalog(SPORTS_TYPE, 'nuvio_sports_live', {}, {});
    const meta = cat.metas.find(m => m.id === 'nuvio_sport_sports_type_fixture');
    expect(meta).toBeDefined();
    expect(meta.type).toBe(SPORTS_TYPE);

    const detail = await handleMeta(SPORTS_TYPE, 'nuvio_sport_sports_type_fixture', {});
    expect(detail.meta).toBeTruthy();
    expect(detail.meta.type).toBe(SPORTS_TYPE);
  });
});
