'use strict';

const {
  byteRelayEnabled, byteRelayGate, relayMode, shouldRelaySegments, playlistHasIspBlockedHost, BYTE_RELAY_PATHS
} = require('../src/services/SegmentRelayPolicy');

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.type = (t) => { res.headers['content-type'] = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

describe('BYTE_RELAY policy', () => {
  test('defaults to off on Vercel and on elsewhere; explicit values win', () => {
    expect(byteRelayEnabled({})).toBe(true);
    expect(byteRelayEnabled({ VERCEL: '1' })).toBe(false);
    expect(byteRelayEnabled({ VERCEL: '1', BYTE_RELAY: 'on' })).toBe(true);
    expect(byteRelayEnabled({ BYTE_RELAY: 'off' })).toBe(false);
  });

  test('when off, no playlist relays its segments, whatever SEGMENT_RELAY says', async () => {
    const env = { VERCEL: '1', SEGMENT_RELAY: 'always' };
    expect(relayMode(env)).toBe('off');
    const req = { query: { referer: 'https://embed.example/' }, headers: {} };
    expect(shouldRelaySegments(req, env)).toBe(false);
    const poisoned = { isPoisonedHost: () => true };
    expect(await playlistHasIspBlockedHost('#EXTM3U\n#EXTINF:6,\nhttps://cdn.example/a.ts\n', 'https://cdn.example/p.m3u8', poisoned, env))
      .toBe(false);
  });

  test('when on, a client without the provider headers still gets relayed segments', () => {
    const req = { query: { referer: 'https://embed.example/' }, headers: {} };
    expect(shouldRelaySegments(req, {})).toBe(true);
  });

  test('the gate refuses every media relay route when off', () => {
    const gate = byteRelayGate({ VERCEL: '1' });
    for (const p of BYTE_RELAY_PATHS) {
      const res = fakeRes();
      const next = jest.fn();
      gate({ path: p }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    for (const p of ['/api/manifest', '/api/manifest.m3u8', '/catalog/Sports/a.json', '/img']) {
      const next = jest.fn();
      gate({ path: p }, fakeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  test('the gate lets the relay routes through when on', () => {
    const next = jest.fn();
    byteRelayGate({})({ path: '/api/hlschunk' }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('index.js mounts the gate ahead of the relay routes', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const gate = src.indexOf("require('./services/SegmentRelayPolicy').byteRelayGate()");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("require('./routes/streamProxy')"));
    expect(gate).toBeLessThan(src.indexOf("require('./routes/dash')"));
  });
});
