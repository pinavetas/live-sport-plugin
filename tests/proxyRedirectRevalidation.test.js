'use strict';

// /api/mp4proxy and /api/fastmp4 gate the URL they are given with the SSRF
// guard, but fetch() follows redirects by itself — a public URL answering
// `302 Location: http://169.254.169.254/` used to be dialled unchecked. These
// tests drive the real routes with a mocked fetch() and a stubbed DNS resolver
// (no network), and prove every redirect hop is re-checked.

const http = require('http');
const express = require('express');

const adaptiveDnsResolver = require('../src/services/AdaptiveDnsResolver');
const streamProxyRouter = require('../src/routes/streamProxy');

const DNS = {
  'cdn.public-cdn.com': '93.184.216.34',
  'edge.public-cdn.com': '93.184.216.35',
  'rebind.attacker.com': '10.0.0.7',
};
jest.spyOn(adaptiveDnsResolver, 'lookup').mockImplementation((host, opts, cb) => {
  const address = DNS[host];
  if (!address) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
  return cb(null, [{ address, family: 4 }]);
});
// The guard asks system DNS first and only falls back to the adaptive resolver
// on a sinkhole/NXDOMAIN answer, so stub both or real DNS leaks into the test.
jest.spyOn(require('dns').promises, 'lookup').mockImplementation(async (host) => {
  const address = DNS[host];
  if (!address) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return [{ address, family: 4 }];
});

const START = 'https://cdn.public-cdn.com/video/1.mp4';
const EDGE = 'https://edge.public-cdn.com/video/1.mp4';
const BODY = Buffer.from('0123456789');

const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
const partial = (buf, total) => new Response(buf, {
  status: 206,
  headers: {
    'content-type': 'video/mp4',
    'content-length': String(buf.length),
    'content-range': `bytes 0-${buf.length - 1}/${total}`,
  },
});

let server;
let port;
let fetchSpy;

beforeAll((done) => {
  const app = express();
  app.use(streamProxyRouter);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  console.warn.mockRestore();
  console.error.mockRestore();
});

// The client side uses node:http so it is not affected by the fetch() mock.
// `settleMs` bounds a response that stops short of its Content-Length.
function get(path, headers = {}, settleMs = 0) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      if (settleMs) {
        setTimeout(() => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks), complete: res.complete });
          req.destroy();
        }, settleMs);
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), complete: res.complete }));
      res.on('error', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), complete: false }));
      res.on('aborted', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), complete: false }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err }));
  });
}

const dialled = () => fetchSpy.mock.calls.map(([url]) => String(url));

describe('/api/mp4proxy — redirects are re-validated hop by hop', () => {
  test.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback resolver port', 'http://127.0.0.1:7003/api/health'],
    ['RFC1918 literal', 'http://192.168.1.1/'],
    ['public name resolving to a private address', 'http://rebind.attacker.com/x.mp4'],
  ])('a 302 to %s is blocked with 403 and never dialled', async (_label, target) => {
    fetchSpy.mockImplementation(async (url) => (String(url) === START ? redirect(target) : partial(BODY, 10)));

    const res = await get(`/api/mp4proxy?url=${encodeURIComponent(START)}`);

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString()).error).toBe('Blocked outbound URL');
    expect(dialled()).toEqual([START]);
  });

  test('uses manual redirect mode so fetch() can never follow a hop itself', async () => {
    fetchSpy.mockImplementation(async () => partial(BODY, 10));
    await get(`/api/mp4proxy?url=${encodeURIComponent(START)}`);
    expect(fetchSpy).toHaveBeenCalled();
    for (const [, init] of fetchSpy.mock.calls) expect(init.redirect).toBe('manual');
  });

  test('a relative Location is resolved against the current hop before the check', async () => {
    fetchSpy.mockImplementation(async (url) => (String(url) === EDGE ? redirect('//127.0.0.1:7003/x') : redirect(EDGE)));
    const res = await get(`/api/mp4proxy?url=${encodeURIComponent(START)}`);
    expect(res.status).toBe(403);
    expect(dialled()).toEqual([START, EDGE]);
  });

  test('a public-to-public redirect is still followed and streamed', async () => {
    fetchSpy.mockImplementation(async (url) => (String(url) === START ? redirect(EDGE, 301) : partial(BODY, 10)));

    const res = await get(`/api/mp4proxy?url=${encodeURIComponent(START)}`, { Range: 'bytes=0-9' });

    expect(res.status).toBe(206);
    expect(res.body.toString()).toBe('0123456789');
    expect(dialled()).toEqual([START, EDGE]);
  });

  test('a redirect loop is cut off after 5 hops', async () => {
    let n = 0;
    fetchSpy.mockImplementation(async () => redirect(`https://cdn.public-cdn.com/loop/${++n}`));

    const res = await get(`/api/mp4proxy?url=${encodeURIComponent(START)}`);

    expect(res.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(6); // the original request + 5 followed hops
  });
});

describe('/api/fastmp4 — redirects are re-validated hop by hop', () => {
  test('a probe redirected to loopback is blocked with 403', async () => {
    fetchSpy.mockImplementation(async (url) => (String(url) === START ? redirect('http://127.0.0.1:7003/') : partial(BODY, 10)));

    const res = await get(`/api/fastmp4?url=${encodeURIComponent(START)}`);

    expect(res.status).toBe(403);
    expect(dialled()).toEqual([START]);
  });

  test('a chunk request redirected to cloud metadata is never dialled', async () => {
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url) !== START) return partial(BODY, 10);
      return init.headers.Range === 'bytes=0-0'
        ? partial(BODY.subarray(0, 1), 10)
        : redirect('http://169.254.169.254/latest/meta-data/');
    });

    // Headers are already sent when a chunk fails, so the body just stops short.
    const res = await get(`/api/fastmp4?url=${encodeURIComponent(START)}`, {}, 500);

    expect(res.complete).toBe(false);
    expect(res.body.length).toBe(0);
    expect(dialled().every((u) => u === START)).toBe(true);
  });

  test('public redirects are still followed for both the probe and the chunks', async () => {
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url) === START) return redirect(EDGE);
      return init.headers.Range === 'bytes=0-0' ? partial(BODY.subarray(0, 1), 10) : partial(BODY, 10);
    });

    const res = await get(`/api/fastmp4?url=${encodeURIComponent(START)}`);

    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('0123456789');
    expect(dialled()).toEqual([START, EDGE, START, EDGE]);
  });
});
