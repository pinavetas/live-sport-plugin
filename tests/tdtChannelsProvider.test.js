'use strict';

process.env.NODE_ENV = 'test';

const TdtChannelsProvider = require('../src/providers/TdtChannelsProvider');
const { isPlayableOption } = TdtChannelsProvider;
const tvJson = require('./fixtures/providers/tdtchannels-tv.json');

const passthroughBreaker = {
  wrap: (name, fn) => ({ fire: fn }),
  wrapSync: (name, fn) => ({ fire: fn })
};

function makeProvider() {
  return new TdtChannelsProvider({ circuitBreaker: passthroughBreaker });
}

describe('TdtChannelsProvider.isPlayableOption', () => {
  test('accepts direct HLS options only', () => {
    expect(isPlayableOption({ format: 'm3u8', url: 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8' })).toBe(true);
    expect(isPlayableOption({ format: 'youtube', url: 'https://www.youtube.com/channel/x/live' })).toBe(false);
    expect(isPlayableOption({ format: 'stream', url: 'https://player.twitch.tv/?channel=x' })).toBe(false);
  });

  test('rejects ad-insertion templates with unfilled [MACRO] slots', () => {
    expect(isPlayableOption({ format: 'm3u8', url: 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=1&ip=[IP]&ua=[UA]' })).toBe(false);
  });
});

describe('TdtChannelsProvider.parseList', () => {
  const channels = makeProvider().parseList(tvJson);

  test('keeps only sports channels with at least one direct HLS option', () => {
    // Generalistas (La 1) and Eventos (Mediaset) are not sports; Aragón Deporte (no options)
    // and AS (YouTube only) have nothing playable.
    expect(channels.map(c => c.id).sort()).toEqual([
      'tdt_ch_esport3',
      'tdt_ch_etb-deportes-kirolak-360',
      'tdt_ch_real-madrid-tv',
      'tdt_ch_tdp',
      'tdt_ch_teledeporte'
    ]);
  });

  test('builds 24/7 networks entries with logo, identity and Spanish metadata', () => {
    const tdp = channels.find(c => c.id === 'tdt_ch_teledeporte');
    expect(tdp).toMatchObject({ category: 'networks', title: 'Teledeporte', league: 'Spain', channelIdentityKey: 'teledeporte' });
    expect(tdp.logo).toMatch(/^https:\/\//);
    // The ad-stitched ottera fallback is dropped, the RTVE origin is kept.
    expect(tdp.sources).toHaveLength(1);
    expect(tdp.sources[0]).toMatchObject({
      source: 'tdtchannels',
      url: 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
      geo: 'SP',
      language: 'Spanish',
      countryCode: 'ES',
      type: 'channel'
    });
    expect(Buffer.from(tdp.sources[0].id, 'base64url').toString()).toBe(tdp.sources[0].url);
  });

  test('channel titles carry no parentheses', () => {
    expect(channels.find(c => c.id === 'tdt_ch_etb-deportes-kirolak-360').title).not.toMatch(/[()]/);
  });

  test('handles missing or malformed lists', () => {
    const p = makeProvider();
    expect(p.parseList(null)).toEqual([]);
    expect(p.parseList({ countries: [{ name: 'Portugal', ambits: [] }] })).toEqual([]);
    expect(p.parseList({ countries: [{ name: 'Spain', ambits: [{ name: 'Deportivos', channels: [null, { name: 'X' }] }] }] })).toEqual([]);
  });
});

describe('TdtChannelsProvider caching', () => {
  test('fetches the list once per TTL and returns fresh entities each sync', async () => {
    const p = makeProvider();
    p.fetchList = { fire: jest.fn(async () => tvJson) };
    const first = await p.getMatches();
    first[0].sources.push({ source: 'mutated-by-aggregator' });
    const second = await p.getMatches();
    expect(p.fetchList.fire).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(first.length);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].sources.some(s => s.source === 'mutated-by-aggregator')).toBe(false);
  });

  test('coalesces concurrent refreshes into one request', async () => {
    const p = makeProvider();
    let release;
    p.fetchList = { fire: jest.fn(() => new Promise(r => { release = () => r(tvJson); })) };
    const a = p.getMatches();
    const b = p.getMatches();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(p.fetchList.fire).toHaveBeenCalledTimes(1);
    expect(ra.length).toBe(rb.length);
  });

  test('serves the stale list when a refresh fails, [] when there is none', async () => {
    const p = makeProvider();
    p.fetchList = { fire: async () => { throw new Error('HTTP 502'); } };
    await expect(p.getMatches()).resolves.toEqual([]);

    p.fetchList = { fire: async () => tvJson };
    const ok = await p.getMatches();
    p._cache.at = 0; // expire
    p.fetchList = { fire: async () => { throw new Error('safeFetch timeout'); } };
    const stale = await p.getMatches();
    expect(stale.map(c => c.id)).toEqual(ok.map(c => c.id));
  });

  test('bad JSON is handled as a failed fetch', async () => {
    const p = makeProvider();
    p.fetchList = null;
    p.proxyFetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } });
    await expect(p.getMatches()).resolves.toEqual([]);
  });
});

describe('TdtChannelsProvider.resolveStream', () => {
  test('emits the broadcaster URL directly, web-ready, tagged Spanish', async () => {
    const url = 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8';
    const streams = await makeProvider().resolveStream(Buffer.from(url).toString('base64url'), 'networks', 'Teledeporte', {
      url, channelName: 'Teledeporte', canonicalChannel: 'Teledeporte', geo: 'SP', optionIndex: 1
    });
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      url,
      title: 'TDTChannels (Teledeporte) [Geo SP]',
      language: 'Spanish',
      countryCode: 'ES',
      behaviorHints: { notWebReady: false }
    });
    expect(streams[0].url).not.toMatch(/\/api\//);
  });

  test('decodes the URL from the id and numbers secondary options', async () => {
    const url = 'https://ztnr.rtve.es/ztnr/6712453.m3u8';
    const [s] = await makeProvider().resolveStream(Buffer.from(url).toString('base64url'), 'networks', '+tdp', { optionIndex: 2 });
    expect(s.url).toBe(url);
    expect(s.title).toBe('TDTChannels (+tdp) #2');
  });

  test('returns nothing for garbage ids', async () => {
    await expect(makeProvider().resolveStream('', 'networks', 'x', {})).resolves.toEqual([]);
  });
});
