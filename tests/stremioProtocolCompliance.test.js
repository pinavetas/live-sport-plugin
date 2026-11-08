'use strict';

const { manifest } = require('../src/manifest');
const { mapMatchToMetaPreview } = require('../src/catalog');

describe('Stremio Protocol Compliance & Enhancements', () => {
  describe('Manifest schema & search storm prevention', () => {
    test('primary live and teams catalogs declare search, but sport sub-catalogs do not', () => {
      const liveCat = manifest.catalogs.find(c => c.id === 'nuvio_sports_live');
      const teamsCat = manifest.catalogs.find(c => c.id === 'nuvio_sports_teams');
      const footballCat = manifest.catalogs.find(c => c.id === 'nuvio_sports_football');
      const basketballCat = manifest.catalogs.find(c => c.id === 'nuvio_sports_basketball');

      expect(liveCat.extra.some(e => e.name === 'search')).toBe(true);
      expect(teamsCat.extra.some(e => e.name === 'search')).toBe(true);
      expect(footballCat.extra.some(e => e.name === 'search')).toBe(false);
      expect(basketballCat.extra.some(e => e.name === 'search')).toBe(false);
    });

    test('live, upcoming and sub-catalogs declare skip to enable Stremio infinite scroll', () => {
      const liveCat = manifest.catalogs.find(c => c.id === 'nuvio_sports_live');
      const upcomingCat = manifest.catalogs.find(c => c.id === 'nuvio_sports_upcoming');
      const footballCat = manifest.catalogs.find(c => c.id === 'nuvio_sports_football');

      expect(liveCat.extra.some(e => e.name === 'skip')).toBe(true);
      expect(upcomingCat.extra.some(e => e.name === 'skip')).toBe(true);
      expect(footballCat.extra.some(e => e.name === 'skip')).toBe(true);
    });

    test('replayFilter in manifest config uses type select with options all and mainstream', () => {
      const replayFilterCfg = manifest.config.find(c => c.key === 'replayFilter');
      expect(replayFilterCfg).toBeDefined();
      expect(replayFilterCfg.type).toBe('select');
      expect(replayFilterCfg.options).toEqual(['all', 'mainstream']);
      expect(replayFilterCfg.default).toBe('all');
    });
  });

  describe('Replay multi-part UX (defaultVideoId)', () => {
    test('single-video replay retains defaultVideoId for immediate playback', () => {
      const singleMatch = {
        id: 'single-match-1',
        title: 'Real Madrid vs Barcelona',
        category: 'football',
        status: 'finished',
        date: '2026-09-18T19:00:00Z',
        sources: [{ source: 'replayzone', name: 'Full Match', url: 'https://example.com/replay' }]
      };
      const meta = mapMatchToMetaPreview(singleMatch, {}, 'series');
      expect(meta.videos).toHaveLength(1);
      expect(meta.behaviorHints.defaultVideoId).toBe('nuvio_sport_single-match-1:1:1');
    });

    test('multi-part replay omits defaultVideoId so Stremio shows episode/part selection', () => {
      const multiPartMatch = {
        id: 'multi-match-2',
        title: 'Liverpool vs Man City',
        category: 'football',
        status: 'finished',
        date: '2026-09-18T19:00:00Z',
        sources: [
          { source: 'soccerfull', name: '1st Half', url: 'https://example.com/part1' },
          { source: 'soccerfull', name: '2nd Half', url: 'https://example.com/part2' }
        ]
      };
      const meta = mapMatchToMetaPreview(multiPartMatch, {}, 'series');
      expect(meta.videos).toHaveLength(2);
      expect(meta.behaviorHints.defaultVideoId).toBeUndefined();
    });
  });
});
