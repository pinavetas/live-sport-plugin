'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const publicResolverApiGate = require('../src/services/PublicResolverApiGate');

describe('public resolver proxy access', () => {
  let server;
  let port;

  beforeAll(async () => {
    const app = express();
    // This public route is handled before the resolver proxy in src/index.js.
    app.get('/api/provider-health', (_req, res) => res.send('dashboard'));
    app.use('/api', publicResolverApiGate, (req, res) => res.send('forwarded:' + req.path));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  function request(requestPath, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: requestPath, method,
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  test.each([
    ['/api/cache/key', 'GET'],
    ['/api/cache/key?claim=1', 'GET'],
    ['/api/cache/key', 'POST'],
    ['/api/cache/key', 'DELETE'],
    ['/api/cache/prune', 'POST'],
    ['/api/cache-stats', 'GET'],
    ['/api/cache-stats/', 'GET'],
    ['/api/cache', 'GET'],
    ['/api/%63ache/key', 'GET'],
    ['/api/cache%2Fkey', 'GET'],
    ['/api/%2563ache/key', 'GET'],
    ['/api/unknown', 'GET'],
    ['/api/streaming', 'POST'],
  ])('denies public resolver route %s (%s)', async (requestPath, method) => {
    const result = await request(requestPath, method);
    expect(result).toEqual({ status: 404, body: 'Not found' });
  });

  test.each([
    ['/api/stream', 'POST', 'forwarded:/stream'],
    ['/api/health', 'GET', 'forwarded:/health'],
    ['/api/health?check=1', 'GET', 'forwarded:/health'],
  ])('preserves public resolver route %s (%s)', async (requestPath, method, body) => {
    expect(await request(requestPath, method)).toEqual({ status: 200, body });
  });

  test('does not interfere with public endpoints mounted before the gate', async () => {
    expect(await request('/api/provider-health')).toEqual({ status: 200, body: 'dashboard' });
  });

  test('the gate precedes the catch-all resolver proxy in the application', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const gateAt = source.indexOf("app.use('/api', require('./services/PublicResolverApiGate'))");
    const proxyAt = source.indexOf("app.use('/api', createProxyMiddleware");
    expect(gateAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeGreaterThan(gateAt);
  });
});
