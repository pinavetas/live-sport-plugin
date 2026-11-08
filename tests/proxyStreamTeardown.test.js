'use strict';

// /api/mp4proxy and /api/hlschunk stream an upstream body to the player. They
// used .pipe(), which (a) leaves an upstream 'error' unhandled and the response
// hanging when the upstream resets mid-body, and (b) keeps the upstream socket
// open after the player disconnects. These tests run the real router against a
// local upstream server; the SSRF guard is stubbed because that upstream lives
// on 127.0.0.1 (the guard itself is covered by ssrfGuard*.test.js).

jest.mock('../src/services/OutboundUrlGuard', () => {
  const actual = jest.requireActual('../src/services/OutboundUrlGuard');
  return {
    ...actual,
    checkOutboundUrl: jest.fn(async (url) => ({ ok: true, url, hostname: new URL(url).hostname, addresses: [] })),
  };
});

const http = require('http');
const express = require('express');
const streamProxyRouter = require('../src/routes/streamProxy');

// One MPEG-TS packet, so the hlschunk uncloak transform passes data straight on.
const TS_PACKET = Buffer.alloc(188, 0xff);
TS_PACKET[0] = 0x47;
const TS_BLOCK = Buffer.concat(Array(64).fill(TS_PACKET)); // ~12 KB

let upstream;
let upstreamPort;
let proxy;
let proxyPort;
let upstreamClosed; // path -> Promise resolved when the upstream sees the request close
let uncaught;

const onUncaught = (err) => { uncaught.push(err); };

beforeAll(async () => {
  const handlers = {
    // Sends some data then keeps the connection open forever (live trickle).
    '/endless': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(TS_BLOCK);
      const timer = setInterval(() => res.write(TS_BLOCK), 50);
      req.on('close', () => clearInterval(timer));
      res.on('close', () => clearInterval(timer));
    },
    // Promises a large body, sends part of it, then resets the connection.
    '/reset': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(TS_BLOCK.length * 100) });
      res.write(TS_BLOCK, () => setTimeout(() => res.socket.destroy(), 30));
    },
    '/ok': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(TS_BLOCK.length) });
      res.end(TS_BLOCK);
    },
  };

  upstreamClosed = {};
  upstream = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const key = req.url;
    upstreamClosed[key] = new Promise((resolve) => res.on('close', resolve));
    (handlers[path] || ((q, r) => { r.writeHead(404); r.end(); }))(req, res);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  const app = express();
  app.use(streamProxyRouter);
  proxy = http.createServer(app);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = proxy.address().port;
});

afterAll(async () => {
  upstream.closeAllConnections();
  proxy.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => proxy.close(r));
});

beforeEach(() => {
  uncaught = [];
  process.on('uncaughtException', onUncaught);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.removeListener('uncaughtException', onUncaught);
  jest.restoreAllMocks();
});

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)),
]);

let seq = 0;
function proxyPath(route, upstreamPath) {
  const target = `http://127.0.0.1:${upstreamPort}${upstreamPath}?n=${++seq}`;
  return { path: `${route}?url=${encodeURIComponent(target)}`, key: `${upstreamPath}?n=${seq}` };
}

/** Open a proxied stream, read the first bytes, then hang up like a player seeking away. */
function readThenDisconnect(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path, agent: false }, (res) => {
      res.once('data', () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on('error', () => {});
    req.setTimeout(3000, () => reject(new Error('no data from proxy')));
  });
}

/** Read the full response; report whether it completed or was cut. */
function readAll(path) {
  return new Promise((resolve) => {
    let bytes = 0;
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path, agent: false }, (res) => {
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes, complete: res.complete }));
      res.on('error', () => resolve({ status: res.statusCode, bytes, complete: false }));
      res.on('aborted', () => resolve({ status: res.statusCode, bytes, complete: false }));
    });
    req.on('error', () => resolve({ status: 0, bytes, complete: false }));
  });
}

describe.each(['/api/mp4proxy', '/api/hlschunk'])('%s teardown', (route) => {
  test('client disconnect aborts the upstream request', async () => {
    const { path, key } = proxyPath(route, '/endless');
    await readThenDisconnect(path);
    await expect(withTimeout(upstreamClosed[key], 3000, 'upstream close')).resolves.toBeUndefined();
  });

  test('an upstream reset mid-body destroys the response instead of hanging, with no uncaught error', async () => {
    const { path } = proxyPath(route, '/reset');
    const result = await withTimeout(readAll(path), 4000, 'proxied response');

    expect(result.status).toBe(200);
    expect(result.complete).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThan(TS_BLOCK.length * 100);
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaught).toEqual([]);
  });

  test('a normal body is still streamed completely', async () => {
    const { path } = proxyPath(route, '/ok');
    const result = await withTimeout(readAll(path), 4000, 'proxied response');
    expect(result).toEqual({ status: 200, bytes: TS_BLOCK.length, complete: true });
    expect(uncaught).toEqual([]);
  });
});
