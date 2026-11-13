'use strict';

// Stremio ignores behaviorHints.proxyHeaders for live HLS (notWebReady:false),
// so its player fetches CDN segments without the Referer/Origin/UA many CDNs
// require (403). The playlist request shows whether the client applies those
// headers; when it does not, segments are relayed through /api/hlschunk.

const { shouldRelaySegments, relayMode } = require('../src/services/SegmentRelayPolicy');
const { rewriteHlsPlaylist } = require('../src/services/HlsRewriteService');

const req = (query, headers = {}) => ({ query, headers });
const UPSTREAM = { url: 'http://cdn.example.org/live/index.m3u8', referer: 'http://www.fawanews.sc/', origin: 'http://www.fawanews.sc' };

describe('shouldRelaySegments (auto)', () => {
  test('client without the upstream headers (Stremio) -> relay', () => {
    expect(shouldRelaySegments(req(UPSTREAM), {})).toBe(true);
  });

  test('client sending the upstream Referer (Nuvio/ExoPlayer) -> direct', () => {
    expect(shouldRelaySegments(req(UPSTREAM, { referer: 'http://www.fawanews.sc/' }), {})).toBe(false);
  });

  test('client sending the upstream Origin -> direct', () => {
    expect(shouldRelaySegments(req(UPSTREAM, { origin: 'http://www.fawanews.sc' }), {})).toBe(false);
  });

  test('a different Referer (e.g. the web player page) still relays', () => {
    expect(shouldRelaySegments(req(UPSTREAM, { referer: 'https://web.stremio.com/' }), {})).toBe(true);
  });

  test('streams that declare no upstream Referer stay direct', () => {
    expect(shouldRelaySegments(req({ url: UPSTREAM.url }), {})).toBe(false);
  });
});

describe('SEGMENT_RELAY override', () => {
  test('off never relays, always always relays', () => {
    expect(shouldRelaySegments(req(UPSTREAM), { SEGMENT_RELAY: 'off' })).toBe(false);
    expect(shouldRelaySegments(req({ url: UPSTREAM.url }, { referer: UPSTREAM.referer }), { SEGMENT_RELAY: 'always' })).toBe(true);
  });

  test('unknown values fall back to auto', () => {
    expect(relayMode({ SEGMENT_RELAY: 'nonsense' })).toBe('auto');
    expect(relayMode({})).toBe('auto');
  });
});

describe('playlistHasIspBlockedHost', () => {
  const { playlistHasIspBlockedHost, segmentHosts } = require('../src/services/SegmentRelayPolicy');
  const media = '#EXTM3U\n#EXTINF:4,\nhttps://blocked-cdn.example.com/a.ts\n#EXTINF:4,\nhttps://blocked-cdn.example.com/b.ts\n';
  const resolver = (poisoned, learnOnLookup = false) => {
    const set = new Set(poisoned);
    return {
      isPoisonedHost: (h) => set.has(h),
      lookup: jest.fn((h, o, cb) => { if (learnOnLookup) set.add(h); cb(null, []); }),
    };
  };

  test('collects media hosts, skipping variant playlists', () => {
    expect(segmentHosts(media, 'https://x.example.com/')).toEqual(['blocked-cdn.example.com']);
    expect(segmentHosts('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', 'https://x.example.com/')).toEqual([]);
  });

  test('a host already known as ISP-blocked -> relay, without a new lookup', async () => {
    const r = resolver(['blocked-cdn.example.com']);
    await expect(playlistHasIspBlockedHost(media, 'https://x.example.com/', r, {})).resolves.toBe(true);
    expect(r.lookup).not.toHaveBeenCalled();
  });

  test('an unknown host is looked up once; a sinkhole answer -> relay', async () => {
    const r = resolver([], true);
    await expect(playlistHasIspBlockedHost(media, 'https://x.example.com/', r, {})).resolves.toBe(true);
    expect(r.lookup).toHaveBeenCalledTimes(1);
  });

  test('a reachable host -> direct; SEGMENT_RELAY=off disables the check', async () => {
    await expect(playlistHasIspBlockedHost(media, 'https://x.example.com/', resolver([]), {})).resolves.toBe(false);
    await expect(playlistHasIspBlockedHost(media, 'https://x.example.com/', resolver(['blocked-cdn.example.com']), { SEGMENT_RELAY: 'off' })).resolves.toBe(false);
  });
});

describe('rewriteHlsPlaylist with relaySegments', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:5',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.org/k.key"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.6,',
    'seg-1.ts',
    '#EXTINF:4.6,',
    'https://cdn.example.org/live/seg-2.m4s',
  ].join('\n');
  const opts = {
    referer: UPSTREAM.referer, origin: UPSTREAM.origin, userAgent: 'Mozilla/5.0 Test',
    absoluteAddonBaseUrl: 'http://192.168.1.10:7000',
  };

  test('segments go through /api/hlschunk with the upstream headers', () => {
    const out = rewriteHlsPlaylist(playlist, UPSTREAM.url, { ...opts, relaySegments: true });
    const seg1 = out.split('\n').find(l => l.includes('seg-1.ts'));
    const u = new URL(seg1);
    expect(u.origin + u.pathname).toBe('http://192.168.1.10:7000/api/hlschunk');
    expect(u.searchParams.get('url')).toBe('http://cdn.example.org/live/seg-1.ts');
    expect(u.searchParams.get('referer')).toBe(UPSTREAM.referer);
    expect(u.searchParams.get('origin')).toBe(UPSTREAM.origin);
    expect(u.searchParams.get('ua')).toBe('Mozilla/5.0 Test');
    expect(u.searchParams.get('raw')).toBeNull(); // TS keeps the uncloak filter
  });

  test('fMP4 segments, keys and init sections are relayed byte-exact (raw=1)', () => {
    const out = rewriteHlsPlaylist(playlist, UPSTREAM.url, { ...opts, relaySegments: true });
    const seg2 = new URL(out.split('\n').find(l => l.includes('seg-2.m4s')));
    expect(seg2.searchParams.get('raw')).toBe('1');
    const key = out.split('\n').find(l => l.startsWith('#EXT-X-KEY'));
    const keyUrl = new URL(key.match(/URI="([^"]+)"/)[1]);
    expect(keyUrl.pathname).toBe('/api/hlschunk');
    expect(keyUrl.searchParams.get('url')).toBe('https://keys.example.org/k.key');
    expect(keyUrl.searchParams.get('raw')).toBe('1');
    const map = out.split('\n').find(l => l.startsWith('#EXT-X-MAP'));
    expect(new URL(map.match(/URI="([^"]+)"/)[1]).searchParams.get('url')).toBe('http://cdn.example.org/live/init.mp4');
  });

  test('a variant without .m3u8 in its path is proxied as a playlist, never relayed as a segment', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhttp://nexus.example.org/play/live.php?stream=1&extension=m3u8\n';
    const out = rewriteHlsPlaylist(master, UPSTREAM.url, { ...opts, relaySegments: true });
    const variant = new URL(out.split('\n').find(l => l.startsWith('http://192.168.1.10:7000/')));
    expect(variant.pathname).toBe('/api/manifest');
    expect(variant.searchParams.get('url')).toBe('http://nexus.example.org/play/live.php?stream=1&extension=m3u8');
    expect(out).not.toContain('/api/hlschunk');
  });

  test('without relay, segments, keys and init stay direct', () => {
    const out = rewriteHlsPlaylist(playlist, UPSTREAM.url, opts);
    expect(out).toContain('\nhttp://cdn.example.org/live/seg-1.ts');
    expect(out).toContain('URI="https://keys.example.org/k.key"');
    expect(out).not.toContain('/api/hlschunk');
  });
});
