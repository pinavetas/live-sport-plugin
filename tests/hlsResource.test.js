'use strict';

const express = require('express');
const http = require('http');
const byteRangeSigner = require('../src/services/ByteRangeSigner');
const hlsResourceRouter = require('../src/routes/hlsResource');

describe('hlsResource route — 307 redirect handler', () => {
  let app;
  let server;
  let baseUrl;

  beforeAll((done) => {
    app = express();
    app.use(hlsResourceRouter);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  const testCdnUrl = 'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/segment_42.image';

  test('successfully redirects with HTTP 307 and CORS headers on valid token', async () => {
    const { token, psig } = byteRangeSigner.encodeSegmentToken({
      url: testCdnUrl,
      referer: 'https://embed.st/',
      origin: 'https://embed.st',
      prefixBytes: 42
    }, 60000);

    const res = await fetch(`${baseUrl}/api/hls/resource/${token}/media.ts?psig=${encodeURIComponent(psig)}`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Range': 'bytes=42-1022761'
      }
    });

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(testCdnUrl);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('Content-Range');
    expect(res.headers.get('cache-control')).toContain('max-age=30');
  });

  test('also handles the /hls/resource alias route', async () => {
    const { token, psig } = byteRangeSigner.encodeSegmentToken({
      url: testCdnUrl,
      prefixBytes: 42
    }, 60000);

    const res = await fetch(`${baseUrl}/hls/resource/${token}/media.ts?psig=${encodeURIComponent(psig)}`, {
      method: 'GET',
      redirect: 'manual'
    });

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(testCdnUrl);
  });

  test('rejects request with missing psig parameter (HTTP 400)', async () => {
    const res = await fetch(`${baseUrl}/api/hls/resource/sometoken/media.ts`, {
      method: 'GET',
      redirect: 'manual'
    });

    expect(res.status).toBe(400);
  });

  test('rejects request with expired psig signature (HTTP 403)', async () => {
    const { token, psig } = byteRangeSigner.encodeSegmentToken({
      url: testCdnUrl,
      prefixBytes: 42
    }, -5000); // Expired 5 seconds ago

    const res = await fetch(`${baseUrl}/api/hls/resource/${token}/media.ts?psig=${encodeURIComponent(psig)}`, {
      method: 'GET',
      redirect: 'manual'
    });

    expect(res.status).toBe(403);
  });

  test('handles CORS pre-flight OPTIONS request', async () => {
    const res = await fetch(`${baseUrl}/api/hls/resource/anytoken/media.ts`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://web.stremio.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Range'
      }
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('Range');
  });
});
