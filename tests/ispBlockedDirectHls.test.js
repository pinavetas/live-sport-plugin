'use strict';

// A direct HLS stream on a host the ISP's DNS blocks cannot be reached by a
// player on the same network; it is published through the addon's manifest
// proxy instead (which then relays its segments).

const adaptiveDnsResolver = require('../src/services/AdaptiveDnsResolver');
const { wrapIspBlockedDirectHls } = require('../src/streams');

const BASE = 'http://192.168.1.10:7000';
let poisoned;
beforeEach(() => {
  poisoned = new Set();
  jest.spyOn(adaptiveDnsResolver, 'isPoisonedHost').mockImplementation(h => poisoned.has(h));
});
afterEach(() => jest.restoreAllMocks());

const stream = (url, request) => ({ url, behaviorHints: request ? { proxyHeaders: { request } } : {} });

test('a direct HLS URL on a blocked host is wrapped with its own headers', () => {
  poisoned.add('cdn.fubo-like.com');
  const out = wrapIspBlockedDirectHls(stream('https://cdn.fubo-like.com/espn/mono.m3u8?token=abc', {
    Referer: 'https://la18hd.su/', Origin: 'https://la18hd.su', 'User-Agent': 'Mozilla/5.0 Test',
  }), BASE);
  const u = new URL(out);
  expect(u.origin + u.pathname).toBe(`${BASE}/api/manifest`);
  expect(u.searchParams.get('url')).toBe('https://cdn.fubo-like.com/espn/mono.m3u8?token=abc');
  expect(u.searchParams.get('referer')).toBe('https://la18hd.su/');
  expect(u.searchParams.get('origin')).toBe('https://la18hd.su');
  expect(u.searchParams.get('hlsua')).toBe('Mozilla/5.0 Test');
});

test('reachable hosts, non-HLS URLs and already-proxied URLs are left alone', () => {
  const direct = 'https://cdn.open.com/live/index.m3u8';
  expect(wrapIspBlockedDirectHls(stream(direct), BASE)).toBe(direct);

  poisoned.add('cdn.blocked.com');
  const mp4 = 'https://cdn.blocked.com/video.mp4';
  expect(wrapIspBlockedDirectHls(stream(mp4), BASE)).toBe(mp4);

  const proxied = `${BASE}/api/manifest.m3u8?url=${encodeURIComponent('https://cdn.blocked.com/a.m3u8')}`;
  expect(wrapIspBlockedDirectHls(stream(proxied), BASE)).toBe(proxied);
});
