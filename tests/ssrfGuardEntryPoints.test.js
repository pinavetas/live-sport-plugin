'use strict';

// The SSRF guard (OutboundUrlGuard) must sit in front of EVERY endpoint that
// fetches a caller-supplied URL, not only the byte-streaming proxies:
//   - /api/manifest (HLS) and the DASH handler (/api/manifest.mpd, or an .mpd
//     url passed to /api/manifest)
//   - the image fetcher behind /img, /img/badge and /img/match
//   - segment pre-probes, whose URIs come from an upstream playlist
//
// Everything here is offline: DNS answers come from a stub on the shared
// AdaptiveDnsResolver and every outbound client is a Jest mock, so a "blocked"
// assertion also proves the mock was never called.

jest.mock('../src/manifestProxy', () => {
  const actual = jest.requireActual('../src/manifestProxy');
  return { ...actual, fetchUpstreamManifest: jest.fn() };
});
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
jest.mock('../src/remint', () => {
  const actual = jest.requireActual('../src/remint');
  return { ...actual, attemptRemint: jest.fn(async () => null) };
});
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  return { ...actual, request: jest.fn() };
});

const http = require('http');
const express = require('express');
const { Readable } = require('stream');

const adaptiveDnsResolver = require('../src/services/AdaptiveDnsResolver');
const { fetchUpstreamManifest } = require('../src/manifestProxy');
const { safeFetch } = require('../src/impitClient');
const { attemptRemint } = require('../src/remint');
const { request } = require('undici');
const manifestRouter = require('../src/routes/manifest');
const imageService = require('../src/services/ImageService');
const { SegmentLengthService } = require('../src/services/SegmentLengthService');

// Hostname -> address answered by the stubbed resolver.
const DNS = {
  'cdn.public-cdn.com': '93.184.216.34',
  'img.public-cdn.com': '93.184.216.34',
  'rebind.attacker.com': '10.0.0.7',
};
jest.spyOn(adaptiveDnsResolver, 'lookup').mockImplementation((host, opts, cb) => {
  const address = DNS[host];
  if (!address) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
  return cb(null, [{ address, family: 4 }]);
});

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(manifestRouter);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  fetchUpstreamManifest.mockReset();
  safeFetch.mockReset();
  attemptRemint.mockReset();
  attemptRemint.mockResolvedValue(null);
  request.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

const get = (path) => fetch(`${baseUrl}${path}`);
const q = (url) => encodeURIComponent(url);

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXTINF:4.000,',
  'seg_1.ts',
].join('\n');

describe('/api/manifest (HLS) — SSRF gate', () => {
  test.each([
    'http://127.0.0.1:7003/api/health.m3u8',
    'http://169.254.169.254/latest/meta-data/index.m3u8',
    'http://192.168.1.1/admin/index.m3u8',
    'http://localhost:7000/x.m3u8',
    'http://rebind.attacker.com/live/index.m3u8',
  ])('blocks %s with 403 and never fetches it', async (target) => {
    const res = await get(`/api/manifest?url=${q(target)}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Blocked outbound URL');
    expect(fetchUpstreamManifest).not.toHaveBeenCalled();
  });

  test('a public CDN playlist is still proxied', async () => {
    fetchUpstreamManifest.mockResolvedValue(MEDIA_PLAYLIST);
    const target = 'https://cdn.public-cdn.com/live/ok-1/index.m3u8';

    const res = await get(`/api/manifest.m3u8?url=${q(target)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('mpegurl');
    const body = await res.text();
    expect(body).toContain('#EXTM3U');
    expect(fetchUpstreamManifest).toHaveBeenCalledWith(target, expect.any(String), expect.any(String));
  });

  test('a re-minted upstream URL is gated too before it is fetched', async () => {
    const target = 'https://cdn.public-cdn.com/live/expired-1/index.m3u8';
    fetchUpstreamManifest.mockRejectedValueOnce(Object.assign(new Error('HTTP 403'), { statusCode: 403 }));
    attemptRemint.mockResolvedValue('http://127.0.0.1:7003/internal/index.m3u8');

    const res = await get(`/api/manifest?url=${q(target)}&rck=${q('provider|match|0')}`);
    expect(res.status).toBe(403);
    expect(attemptRemint).toHaveBeenCalled();
    // Only the original (public) URL was ever fetched.
    expect(fetchUpstreamManifest).toHaveBeenCalledTimes(1);
    expect(fetchUpstreamManifest.mock.calls[0][0]).toBe(target);
  });
});

describe('DASH manifest proxy — SSRF gate', () => {
  test.each([
    '/api/manifest.mpd?url=',
    '/api/manifest?url=',
  ])('%s blocks a private .mpd target with 403', async (prefix) => {
    const res = await get(`${prefix}${q('http://10.0.0.5/live/stream.mpd')}`);
    expect(res.status).toBe(403);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('a public .mpd is still proxied', async () => {
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period/></MPD>',
    });
    const target = 'https://cdn.public-cdn.com/dash/stream.mpd';

    const res = await get(`/api/manifest.mpd?url=${q(target)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<BaseURL>https://cdn.public-cdn.com/dash/</BaseURL>');
    expect(safeFetch).toHaveBeenCalledWith(target, expect.any(Object));
  });
});

describe('ImageService (/img, /img/badge, /img/match) — SSRF gate', () => {
  // Minimal 64x64 PNG header: signature + IHDR, padded past the 32-byte floor.
  const png = Buffer.alloc(128);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);

  const imageResponse = () => ({
    statusCode: 200,
    headers: { 'content-type': 'image/png' },
    body: Readable.from([png]),
  });

  test.each([
    'http://127.0.0.1:7003/api/health',
    'http://169.254.169.254/latest/meta-data/iam',
    'http://[::1]:7000/logo.png',
    'http://rebind.attacker.com/logo.png',
  ])('getImage refuses %s without dialling it', async (target) => {
    await expect(imageService.getImage(target)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  test('fetchImage refuses a private target without dialling it', async () => {
    await expect(imageService.fetchImage('http://10.1.2.3/crest.png')).resolves.toEqual({ ok: false, bytes: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  test('a public image is still fetched and cached', async () => {
    request.mockImplementation(async () => imageResponse());
    const entry = await imageService.getImage('https://img.public-cdn.com/crest-ok.png');
    expect(entry).not.toBeNull();
    expect(entry.contentType).toBe('image/png');
    expect(entry.width).toBe(64);
    expect(request).toHaveBeenCalledWith('https://img.public-cdn.com/crest-ok.png', expect.any(Object));
  });
});

describe('segment pre-probes — SSRF gate', () => {
  test('a playlist URI pointing at a private address is never probed', async () => {
    const svc = new SegmentLengthService({ maxSize: 10, autoProbe: false });
    await expect(svc.probeContentLength('http://192.168.0.10/tiktokcdn/seg.image')).resolves.toBeNull();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('a public segment URI is still probed', async () => {
    safeFetch.mockResolvedValue({
      status: 206,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-range' ? 'bytes 0-0/500042' : null) },
    });
    const svc = new SegmentLengthService({ maxSize: 10, autoProbe: false });
    await expect(svc.probeContentLength('https://cdn.public-cdn.com/tiktokcdn/seg.image')).resolves.toBe(500000);
    expect(safeFetch).toHaveBeenCalled();
  });
});
