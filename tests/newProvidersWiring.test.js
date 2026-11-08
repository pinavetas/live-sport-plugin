'use strict';

process.env.NODE_ENV = 'test';

// Wiring guard for the BINTV / AngulismoTV / TDTChannels / NBAMonster providers:
// each must be registered in the container, fed to the aggregator, dispatchable
// by streams.js, filterable through liveSources and toggleable on the configure page.

const fs = require('fs');
const path = require('path');
const container = require('../src/container');
const { selectSources, KNOWN_LIVE_SOURCES } = require('../src/streams');

const PROVIDERS = [
  { source: 'bintv', key: 'bintvProvider', cls: 'BintvProvider' },
  { source: 'angulismo', key: 'angulismoProvider', cls: 'AngulismoProvider' },
  { source: 'tdtchannels', key: 'tdtChannelsProvider', cls: 'TdtChannelsProvider' },
  { source: 'nbamonster', key: 'nbaMonsterProvider', cls: 'NbaMonsterProvider' }
];

describe('new live providers are wired end to end', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8');
  const aggregator = container.resolve('matchAggregator');

  test.each(PROVIDERS)('$source is a registered singleton fed to the aggregator', ({ key, cls }) => {
    const provider = container.resolve(key);
    expect(provider.constructor.name).toBe(cls);
    expect(container.resolve(key)).toBe(provider);
    expect(aggregator.providers).toContain(provider);
  });

  test.each(PROVIDERS)('$source is a known live source with a configure checkbox', ({ source }) => {
    expect(KNOWN_LIVE_SOURCES).toContain(source);
    expect(html).toMatch(new RegExp(`<input[^>]*value="${source}"`));
  });

  test('liveSources config can switch each provider off', () => {
    const sources = PROVIDERS.map(p => ({ source: p.source, id: `${p.source}_1` }));
    expect(selectSources(sources, null).map(s => s.source).sort()).toEqual(PROVIDERS.map(p => p.source).sort());
    expect(selectSources(sources, { liveSources: 'tdtchannels' }).map(s => s.source)).toEqual(['tdtchannels']);
    expect(selectSources(sources, { liveSources: 'none' })).toEqual([]);
  });

  test('BINTV gets the TimStreams extractor and NBAMonster the PPV.st one injected', () => {
    expect(container.resolve('bintvProvider').timStreamsProvider).toBe(container.resolve('timStreamsProvider'));
    expect(container.resolve('nbaMonsterProvider').ppvStProvider).toBe(container.resolve('ppvStProvider'));
  });
});
