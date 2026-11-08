'use strict';

// safeFetch({ outboundGuard }) must vet every URL in a redirect chain before it
// is requested. Without it, impit and the undici path followed redirects
// internally, so a vetted public URL answering 302 -> LAN / cloud metadata was
// fetched and its body handed back to the caller (SSRF via redirect).

const http = require('http');

function startServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/public-to-secret') {
      res.writeHead(302, { Location: '/secret' });
      return res.end();
    }
    if (req.url === '/public-to-public') {
      res.writeHead(301, { Location: '/public-final' });
      return res.end();
    }
    if (req.url === '/public-final') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('public body');
    }
    if (req.url === '/secret') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('SECRET');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Test checker: loopback is the only reachable test host, so "public" vs
// "private" is decided by path. Records every URL it was asked about.
function makeChecker() {
  const seen = [];
  const check = async (url) => {
    seen.push(new URL(url).pathname);
    if (new URL(url).pathname.startsWith('/secret')) {
      return { ok: false, reason: 'blocked_address', detail: '10.0.0.1 (private)' };
    }
    return { ok: true, url };
  };
  return { check, seen };
}

function suite(label, loadSafeFetch) {
  describe(`safeFetch outboundGuard (${label})`, () => {
    let srv;
    let safeFetch;

    beforeAll(async () => {
      safeFetch = loadSafeFetch();
      srv = await startServer();
    });
    afterAll(() => new Promise((r) => srv.server.close(r)));
    beforeEach(() => { srv.hits.length = 0; });

    test('refuses a redirect to a blocked target without requesting it', async () => {
      const { check, seen } = makeChecker();
      await expect(
        safeFetch(`${srv.base}/public-to-secret`, { outboundGuard: check, timeoutMs: 5000, attempts: 1 })
      ).rejects.toMatchObject({ code: 'EOUTBOUND_BLOCKED', reason: 'blocked_address' });
      expect(seen).toEqual(['/public-to-secret', '/secret']);
      expect(srv.hits).not.toContain('/secret');
    });

    test('follows a redirect between allowed targets and returns the final body', async () => {
      const { check, seen } = makeChecker();
      const res = await safeFetch(`${srv.base}/public-to-public`, { outboundGuard: check, timeoutMs: 5000, attempts: 1 });
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe('public body');
      expect(seen).toEqual(['/public-to-public', '/public-final']);
    });

    test('the default guard blocks a loopback URL before any request', async () => {
      await expect(
        safeFetch(`${srv.base}/public-final`, { outboundGuard: true, timeoutMs: 5000, attempts: 1 })
      ).rejects.toMatchObject({ code: 'EOUTBOUND_BLOCKED' });
      expect(srv.hits).toHaveLength(0);
    });

    test('without outboundGuard the redirect is still followed (unchanged behaviour)', async () => {
      const res = await safeFetch(`${srv.base}/public-to-public`, { timeoutMs: 5000, attempts: 1 });
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe('public body');
    });
  });
}

// Real engine selection (impit when the native binary is available).
suite('default engine', () => require('../src/impitClient').safeFetch);

// Force the undici path by making impit unavailable.
suite('undici path', () => {
  let fn;
  jest.isolateModules(() => {
    jest.doMock('impit', () => { throw new Error('impit disabled for test'); });
    fn = require('../src/impitClient').safeFetch;
  });
  return fn;
});
