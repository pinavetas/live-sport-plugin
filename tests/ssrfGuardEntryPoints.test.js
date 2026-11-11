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
jest.spyOn(require('dns').promises, 'lookup').mockImplementation(async (host) => {
  const address = DNS[host];
  if (!address) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return [{ address, family: 4 }];
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

// /api/manifest and the DASH proxy no longer gate at the route entry: every
// upstream fetch goes through safeFetch's guarded transport (guardExternal),
// which vets each redirect hop and pins the vetted address. That path is
// covered by guardedPublicEntries.test.js and guardedOutboundTransport.test.js.

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
  test('probes go through the guarded external transport', async () => {
    safeFetch.mockResolvedValue({ status: 404, headers: { get: () => null } });
    const svc = new SegmentLengthService({ maxSize: 10, autoProbe: false });
    await svc.probeContentLength('https://cdn.public-cdn.com/tiktokcdn/other.image');
    expect(safeFetch).toHaveBeenCalled();
    for (const [, opts] of safeFetch.mock.calls) expect(opts.guardExternal).toBe(true);
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
