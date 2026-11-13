'use strict';
// Real loopback HTTP routes; provider/segment traffic is never sent.
jest.mock('../src/container', () => ({ resolve: jest.fn(() => { throw Error('not needed by this fixture'); }) }));
jest.mock('../src/services/SegmentLengthService', () => ({ getSegmentLength: jest.fn(() => 188) }));
const http = require('node:http');

describe('production signing failure isolation', () => {
  const keys = ['NODE_ENV', 'APP_SECRET', 'SESSION_SECRET', 'TIKTOK_SEGMENT_MODE', 'USE_TIKTOK_BYTERANGE_307', 'WORKER_POOL_LOG'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const manifest = 'https://cdn.example.org/live/index.m3u8?token=fixture';
  const segment = 'https://cdn.example.org/live/segment.image?token=fixture';
  let server, base, fatal;
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    delete process.env.APP_SECRET;
    delete process.env.SESSION_SECRET;
    delete process.env.USE_TIKTOK_BYTERANGE_307;
    process.env.TIKTOK_SEGMENT_MODE = 'redirect';
    process.env.WORKER_POOL_LOG = 'off';
    fatal = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      server = undefined;
    }
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.restoreAllMocks();
    jest.resetModules();
  });

  async function listen() {
    const app = require('express')();
    app.use(require('../src/routes/hlsResource'));
    app.use(require('../src/routes/health'));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }

  test('missing production secret keeps health serving but disables GET/HEAD redirects on both aliases', async () => {
    await listen();
    const health = await fetch(base + '/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    const signer = require('../src/services/ByteRangeSigner');
    const { token, psig } = new signer.ByteRangeSigner('nuvio-tiktok-byterange-secret-v1')
      .encodeSegmentToken({ url: segment });
    for (const prefix of ['/api/hls/resource/', '/hls/resource/']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + prefix + token + '/media.ts?psig=' + psig, { method, redirect: 'manual' });
        expect(response.status).toBe(503);
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('cache-control')).toBe('no-store');
        await response.text();
      }
    }
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  test('redirect-mode full playlists keep byte ranges and direct CDN URLs when signing is disabled', () => {
    const service = require('../src/services/HlsRewriteService');
    const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nsegment.image';
    const result = service.rewriteHlsPlaylist(playlist, manifest);
    expect(service.buildByteRangeRedirectUrl(segment)).toBe(segment);
    expect(service.rewriteHlsUri('segment.image', manifest)).toBe(segment);
    expect(result).toContain('#EXT-X-VERSION:4');
    expect(result).toContain('#EXT-X-BYTERANGE:188@42\n' + segment);
    expect(result).not.toMatch(/\/api\/(?:hls\/resource|hlschunk|mp4proxy|fastmp4)|\/seg\.ts\?/);
  });

  test('configured production secret retains signed 307 behavior and rejects tampering', async () => {
    process.env.APP_SECRET = 'shared-fixture-secret';
    await listen();
    const service = require('../src/services/HlsRewriteService');
    const signedPath = service.rewriteHlsUri('segment.image', manifest);
    expect(signedPath).toMatch(/^\/api\/hls\/resource\//);
    const response = await fetch(base + signedPath, { redirect: 'manual', headers: { Range: 'bytes=42-229' } });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(segment);
    await response.text();
    const tampered = await fetch(base + signedPath + 'x', { redirect: 'manual' });
    expect(tampered.status).toBe(403);
    expect(tampered.headers.get('location')).toBeNull();
    await tampered.text();
    expect(fatal).not.toHaveBeenCalled();
  });
});
