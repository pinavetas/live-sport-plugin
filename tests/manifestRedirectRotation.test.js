'use strict';
const http = require('node:http');
const express = require('express');
jest.mock('../src/container', () => ({ resolve: () => ({ noteFailure: jest.fn() }) }));
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
jest.mock('../src/services/SegmentLengthService', () => ({ getSegmentLength: () => 188 }));
jest.mock('../src/services/HlsRewriteService', () => ({
  ...jest.requireActual('../src/services/HlsRewriteService'),
  preprobeManifestSegments: jest.fn(async () => {})
}));
const { safeFetch } = require('../src/impitClient');
const proxy = require('../src/manifestProxy');
const router = require('../src/routes/manifest');
const source = 'https://source.example.org/master.m3u8';
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8\n';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';

describe('combined #27/#52 redirect cache behavior', () => {
  let server, addon, active, release, incoming;
  const savedAddon = process.env.ADDON_URL;
  beforeAll(async () => {
    const app = express();
    app.use((_req, _res, next) => { incoming++; next(); });
    app.use(router);
    // No media: the synthetic init endpoint answers status/headers only.
    app.get('/fixture/init.mp4', (req, res) => res.sendStatus(req.headers.referer === 'https://embed.example.org/' ? 204 : 403));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    addon = 'http://127.0.0.1:' + server.address().port;
    process.env.ADDON_URL = addon;
  });
  beforeEach(() => {
    active = 'a'; release = undefined; incoming = 0;
    proxy.manifestCache.clear(); proxy.manifestInFlight.clear();
    safeFetch.mockReset();
    safeFetch.mockImplementation(async url => {
      if (url === source) return { ok: true, status: 200, url: 'https://cdn-' + active + '.example.org/final/master.m3u8', text: async () => master };
      if (url === 'https://cdn-' + active + '.example.org/final/child.m3u8') return { ok: true, status: 200, url, text: async () => media };
      return { ok: false, status: 410, url };
    });
  });
  afterEach(() => expect(proxy.manifestInFlight.size).toBe(0));
  afterAll(async () => {
    if (savedAddon === undefined) delete process.env.ADDON_URL;
    else process.env.ADDON_URL = savedAddon;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  // Only incoming loopback HTTP is real. Every upstream fetch is mocked.
  function get(path, headers) {
    const parsed = new URL(path, addon);
    if (parsed.origin !== addon) throw Error('Non-fixture network request forbidden');
    return new Promise((resolve, reject) => {
      const request = http.get(parsed, { headers }, response => {
        let body = '';
        response.on('data', data => { body += data; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(Error('local fixture timeout')));
    });
  }
  const route = target => '/api/manifest?' + new URLSearchParams({ url: target });
  const child = response => response.body.split('\n').find(line => line.includes('/api/manifest?'));

  test.each(['/api/manifest', '/api/manifest.m3u8'])('preserves the published %s playback route', async pathname => {
    const response = await get(pathname + '?' + new URLSearchParams({ url: source }));
    expect(response.status).toBe(200);
    expect(response.body).toContain('cdn-a.example.org');
    expect(response.headers['x-manifest-cache']).toBe('BYPASS');
  });

  test('a second viewer follows the current redirect base before the master TTL expires', async () => {
    const first = await get(route(source));
    expect(first.body).toContain('cdn-a.example.org');
    active = 'b';
    const next = await get(route(source));
    const playback = await get(child(next));
    expect(playback.status).toBe(200);
    expect(next.body).toContain('cdn-b.example.org');
    expect(next.headers['cache-control']).toContain('no-store');
    expect(safeFetch.mock.calls.filter(([url]) => url === source)).toHaveLength(2);
  });

  test('non-redirected masters still share the positive cache', async () => {
    safeFetch.mockResolvedValue({ ok: true, status: 200, url: source, text: async () => master });
    await get(route(source));
    const next = await get(route(source));
    expect(next.headers['x-manifest-cache']).toBe('HIT');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  test('concurrent redirected requests still coalesce into one upstream fetch', async () => {
    safeFetch.mockImplementation(() => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, url: 'https://cdn-a.example.org/final/master.m3u8', text: async () => master }); }));
    const a = get(route(source)), b = get(route(source));
    const deadline = Date.now() + 1500;
    while ((!release || incoming < 2) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(release).toBeDefined();
    expect(incoming).toBe(2);
    release();
    const result = await Promise.all([a, b]);
    expect(result[0].status).toBe(200);
    expect(result[1].body).toBe(result[0].body);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(proxy.manifestCache.size).toBe(0);
  });

  test('a direct EXT-X-MAP needs player-supplied Referer when the init host gates it', async () => {
    const init = addon + '/fixture/init.mp4';
    safeFetch.mockResolvedValue({ ok: true, status: 200, url: source, text: async () => '#EXTM3U\n#EXT-X-MAP:URI="' + init + '"\n#EXTINF:6,\nsegment.ts\n' });
    const rendered = await get(route(source));
    expect(rendered.body).toContain('#EXT-X-MAP:URI="' + init + '"');
    expect((await get(init)).status).toBe(403);
    expect((await get(init, { Referer: 'https://embed.example.org/' })).status).toBe(204);
  });
});
