'use strict';

// The manifest proxy caches the REWRITTEN playlist, whose child URLs are
// absolute on the requesting host. A client reaching the addon through a
// second host (LAN IP and a tunnel at the same time) must get its own host in
// those URLs, never a cached copy minted for the other one.

jest.mock('../src/manifestProxy', () => {
  const actual = jest.requireActual('../src/manifestProxy');
  return { ...actual, fetchUpstreamManifest: jest.fn() };
});

// The manifest proxy now vets every fetch target with the SSRF guard, whose DNS
// step cannot resolve the fake upstream host. Let the guard pass here; it is
// covered by ssrfGuardEntryPoints.test.js.
jest.mock('../src/services/OutboundUrlGuard', () => {
  const actual = jest.requireActual('../src/services/OutboundUrlGuard');
  return {
    ...actual,
    checkOutboundUrl: jest.fn(async (url) => ({ ok: true, url, hostname: new URL(url).hostname, addresses: [] })),
  };
});

const http = require('http');
const express = require('express');
const manifestProxy = require('../src/manifestProxy');
const manifestRouter = require('../src/routes/manifest');

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720',
  'chunklist_720.m3u8',
  ''
].join('\n');

function get(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['x-manifest-cache'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('manifest proxy cache is scoped to the requesting base URL', () => {
  let server;
  let port;
  const savedAddonUrl = process.env.ADDON_URL;

  beforeAll((done) => {
    delete process.env.ADDON_URL;
    const app = express();
    app.use(manifestRouter);
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (savedAddonUrl === undefined) delete process.env.ADDON_URL;
    else process.env.ADDON_URL = savedAddonUrl;
    manifestProxy.manifestCache.clear();
    server.close(done);
  });

  beforeEach(() => {
    manifestProxy.manifestCache.clear();
    manifestProxy.fetchUpstreamManifest.mockReset();
    // With { withResponseUrl: true } the route expects { body, url } (url = final, post-redirect URL).
    manifestProxy.fetchUpstreamManifest.mockImplementation(async (url, _r, _o, opts) => (opts && opts.withResponseUrl ? { body: MASTER, url } : MASTER));
  });

  test('two hosts asking for the same upstream each get their own base URL', async () => {
    const path = '/api/manifest.m3u8?url=' + encodeURIComponent('https://cdn.example.invalid/live/master.m3u8');

    const lan = await get(port, path, '192.168.1.50:7000');
    const tunnel = await get(port, path, 'demo.ngrok.example');

    expect(lan.status).toBe(200);
    expect(tunnel.status).toBe(200);
    expect(lan.body).toContain('http://192.168.1.50:7000/api/manifest');
    expect(tunnel.body).toContain('http://demo.ngrok.example/api/manifest');
    expect(tunnel.body).not.toContain('192.168.1.50');
    expect(tunnel.cache).toBe('MISS');
  });

  test('the same host still hits the cache', async () => {
    const path = '/api/manifest.m3u8?url=' + encodeURIComponent('https://cdn.example.invalid/live/master2.m3u8');

    const first = await get(port, path, '192.168.1.50:7000');
    const second = await get(port, path, '192.168.1.50:7000');

    expect(first.cache).toBe('MISS');
    expect(second.cache).toBe('HIT');
    expect(second.body).toBe(first.body);
    expect(manifestProxy.fetchUpstreamManifest).toHaveBeenCalledTimes(1);
  });

  test('a different rck gets its own rewritten body', async () => {
    const base = '/api/manifest.m3u8?url=' + encodeURIComponent('https://cdn.example.invalid/live/master3.m3u8');

    const a = await get(port, base + '&rck=prov%3Am1%3As1', '192.168.1.50:7000');
    const b = await get(port, base + '&rck=prov%3Am2%3As2', '192.168.1.50:7000');

    expect(a.body).toContain('rck=prov%3Am1%3As1');
    expect(b.body).toContain('rck=prov%3Am2%3As2');
    expect(b.body).not.toContain('m1%3As1');
  });
});
