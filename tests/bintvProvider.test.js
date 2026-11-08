'use strict';

process.env.NODE_ENV = 'test';

const BintvProvider = require('../src/providers/BintvProvider');
const MatchAggregator = require('../src/services/MatchAggregator');
const { decodeWrapperUrl, parseFeedDate, decodeEntities } = BintvProvider;
const feed = require('./fixtures/providers/bintv-feed.json');

const passthroughBreaker = {
  wrap: (name, fn) => ({ fire: fn }),
  wrapSync: (name, fn) => ({ fire: fn })
};

function makeProvider(extra = {}) {
  return new BintvProvider({ circuitBreaker: passthroughBreaker, ...extra });
}

describe('BintvProvider helpers', () => {
  test('decodes the base64url embed out of a bintv-sources wrapper', () => {
    expect(decodeWrapperUrl('https://bintv-sources.pages.dev/?id=aHR0cHM6Ly9laGdlbWJ4ZS5jZmQvYmludHYvem83ODNmMWMtNjU1NQ'))
      .toBe('https://ehgembxe.cfd/bintv/zo783f1c-6555');
  });

  test('rejects wrappers whose id does not decode to an http(s) URL', () => {
    const js = Buffer.from('javascript:alert(1)').toString('base64url');
    expect(decodeWrapperUrl(`https://bintv-sources.pages.dev/?id=${js}`)).toBeNull();
    expect(decodeWrapperUrl('not a url')).toBeNull();
    expect(decodeWrapperUrl(undefined)).toBeNull();
  });

  test('parses the feed "YYYY-MM-DD HH:MM UTC" dates as UTC', () => {
    expect(parseFeedDate('2026-11-07 14:00 UTC')).toBe(Date.parse('2026-11-07T14:00:00Z'));
    expect(parseFeedDate(null)).toBeNull();
    expect(parseFeedDate('tomorrow')).toBeNull();
  });

  test('decodes single and double-escaped HTML entities', () => {
    expect(decodeEntities('Texas A&amp;M Aggies')).toBe('Texas A&M Aggies');
    expect(decodeEntities('Texas A&amp;amp;M')).toBe('Texas A&M');
    expect(decodeEntities('Caf&#233;')).toBe('Café');
  });
});

describe('BintvProvider.parseFeed', () => {
  const provider = makeProvider();
  const matches = provider.parseFeed(feed);
  const events = matches.filter(m => m.category !== 'networks');
  const channels = matches.filter(m => m.category === 'networks');

  test('maps live and upcoming events with category, date, status and poster', () => {
    expect(events).toHaveLength(4);
    const haltech = events.find(m => m.title === 'Haltech World Cup Finals: Day Three');
    expect(haltech).toMatchObject({
      id: 'bintv_ev_a4cacf9a8b5e',
      category: 'motorsport',
      status: 'live',
      date: String(Date.parse('2026-11-07T14:00:00Z')),
      thumbnail_url: 'https://tim-streams.com/img/vb72svkx.webp'
    });
    expect(events.find(m => /Buatsi/.test(m.title)).category).toBe('mma');
    const rutgers = events.find(m => /Rutgers/.test(m.title));
    expect(rutgers.status).toBe('upcoming');
    expect(rutgers.category).toBe('american_football');
    expect(rutgers.team1).toEqual({ name: 'Rutgers Scarlet Knights' });
    expect(rutgers.team2).toEqual({ name: 'Wisconsin Badgers' });
  });

  test('turns every stream into a bintv source carrying the decoded embed', () => {
    const rm = events.find(m => m.title === 'Real Madrid @ Valencia');
    expect(rm.sources).toHaveLength(3);
    for (const s of rm.sources) {
      expect(s.source).toBe('bintv');
      expect(s.embedUrl).toMatch(/^https:\/\/ehgembxe\.cfd\/bintv\//);
      expect(Buffer.from(s.id, 'base64url').toString()).toBe(s.embedUrl);
      expect(s.wrapperUrl).toMatch(/^https:\/\/bintv-sources\.pages\.dev\/\?id=/);
    }
    expect(rm.sources.map(s => s.channelName)).toEqual(['DAZN Laliga', 'Spanish', 'ESPN+']);
  });

  test('keeps only sports 24/7 channels and keeps regional variants apart', () => {
    const titles = channels.map(c => c.id).sort();
    expect(titles).toEqual([
      'bintv_ch_dazn-1-germany',
      'bintv_ch_dazn-1-spain',
      'bintv_ch_espn',
      'bintv_ch_fox-sports-501-cricket',
      'bintv_ch_sky-sports-f1'
    ]);
    for (const c of channels) {
      expect(c.date).toBe(''); // MatchEntity folds the '0' evergreen sentinel to ''
      expect(c.channelIdentityKey).toBeTruthy();
      expect(c.sources.every(s => s.type === 'channel' && s.canonicalChannel)).toBe(true);
    }
    // Labels must not carry parentheses (streams.js reads the label from the first "(...)").
    expect(channels.find(c => c.id === 'bintv_ch_fox-sports-501-cricket').title).not.toMatch(/[()]/);
  });

  test('tolerates garbage input without throwing', () => {
    expect(provider.parseFeed(null)).toEqual([]);
    expect(provider.parseFeed('oops')).toEqual([]);
    expect(provider.parseFeed({ 'Live Events': [null, {}, { ID: 'x', Name: 'No streams', Streams: [] }] })).toEqual([]);
  });
});

describe('BintvProvider.getMatches error handling', () => {
  test('returns [] when the feed request fails', async () => {
    const provider = makeProvider();
    provider.fetchFeed = { fire: async () => { throw new Error('safeFetch timeout 10000ms'); } };
    await expect(provider.getMatches()).resolves.toEqual([]);
  });

  test('returns [] when the feed is not JSON', async () => {
    const provider = makeProvider();
    provider.proxyFetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    provider.fetchFeed = null;
    await expect(provider.getMatches()).resolves.toEqual([]);
  });

  test('parses a successful feed fetch', async () => {
    const provider = makeProvider();
    provider.proxyFetch = jest.fn(async () => ({ ok: true, json: async () => feed }));
    provider.fetchFeed = null;
    const matches = await provider.getMatches();
    expect(matches.length).toBe(9);
    expect(provider.proxyFetch).toHaveBeenCalledWith('https://api.yosintv.fun/api/public/bintvjson', expect.any(Object));
  });
});

describe('BintvProvider.resolveStream', () => {
  const src = {
    source: 'bintv',
    id: Buffer.from('https://ehgembxe.cfd/bintv/zo783f1c-6555').toString('base64url'),
    channelName: 'FDRM+',
    embedUrl: 'https://ehgembxe.cfd/bintv/zo783f1c-6555',
    wrapperUrl: 'https://bintv-sources.pages.dev/?id=abc'
  };

  test('reuses the TimStreams extractor with BINTV\'s referer and emits a direct stream + web fallback', async () => {
    const extractM3u8 = jest.fn(async () => ({
      m3u8: 'https://tims-001.sytes.net/main/secure/tok/1794094827/fdrm-1.m3u8',
      referer: 'https://ehgembxe.cfd'
    }));
    const provider = makeProvider({ timStreamsProvider: { extractM3u8 } });
    const streams = await provider.resolveStream(src.id, 'motorsport', 'Haltech', src);

    expect(extractM3u8).toHaveBeenCalledWith(src.embedUrl, 'https://bintv-sources.pages.dev/');
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({
      url: 'https://tims-001.sytes.net/main/secure/tok/1794094827/fdrm-1.m3u8',
      title: 'BINTV (FDRM+)',
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: expect.objectContaining({ Referer: 'https://ehgembxe.cfd/', Origin: 'https://ehgembxe.cfd' }) }
      }
    });
    // Zero-bandwidth policy: never routed through the server's byte proxies.
    expect(streams[0].url).not.toMatch(/\/api\/(?:hlschunk|fastmp4|mp4proxy)/);
    expect(streams[1].externalUrl).toBe(`/watch?url=${encodeURIComponent(src.wrapperUrl)}&title=Haltech`);
  });

  test('decodes the embed from the source id when src fields are missing', async () => {
    const extractM3u8 = jest.fn(async () => null);
    const provider = makeProvider({ timStreamsProvider: { extractM3u8 } });
    const streams = await provider.resolveStream(src.id, 'motorsport', 'Haltech', {});
    expect(extractM3u8).toHaveBeenCalledWith(src.embedUrl, 'https://bintv-sources.pages.dev/');
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain(encodeURIComponent(src.embedUrl));
  });

  test('falls back to the web player when extraction throws', async () => {
    const provider = makeProvider({ timStreamsProvider: { extractM3u8: async () => { throw new Error('boom'); } } });
    const streams = await provider.resolveStream(src.id, 'motorsport', 'Haltech', src);
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toBeDefined();
  });

  test('returns nothing for an id that is not a URL', async () => {
    const provider = makeProvider({ timStreamsProvider: { extractM3u8: jest.fn() } });
    await expect(provider.resolveStream('%%%', 'other', 'x', {})).resolves.toEqual([]);
  });
});

describe('BINTV events merge with the TimStreams copies of the same event', () => {
  const agg = new MatchAggregator({});
  const bintv = makeProvider().parseFeed(feed);

  test('same title and kickoff as a TimStreams row is the same event', () => {
    const rm = bintv.find(m => m.title === 'Real Madrid @ Valencia');
    const ts = { id: 'ts_real-madrid-valencia', title: 'Real Madrid @ Valencia', category: 'football', date: rm.date };
    expect(agg.isSameEvent(rm, ts)).toBe(true);
  });

  test('a differently phrased fixture from another source still merges', () => {
    const rm = bintv.find(m => m.title === 'Real Madrid @ Valencia');
    expect(agg.isSameEvent(rm, { id: 'angulismo_1', title: 'Valencia vs. Real Madrid', category: 'football', date: rm.date })).toBe(true);
  });

  test('different fixtures do not merge', () => {
    const rm = bintv.find(m => m.title === 'Real Madrid @ Valencia');
    expect(agg.isSameEvent(rm, { id: 'ts_x', title: 'Sassuolo @ AS Roma', category: 'football', date: rm.date })).toBe(false);
  });
});
