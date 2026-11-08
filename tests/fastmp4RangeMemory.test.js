'use strict';

// /api/fastmp4 fetches the file as parallel Range sub-requests. An upstream
// that ignores Range answers 200 with the WHOLE file; fetchRangeBuf used to
// accept that and buffer the body with arrayBuffer() — no size cap, no timeout,
// 6-12 times in parallel — so a 1 GB file meant multiple GB of heap. These tests
// use a mocked fetch() whose bodies are endless streams and count how many
// bytes were actually pulled.

const http = require('http');
const express = require('express');

const adaptiveDnsResolver = require('../src/services/AdaptiveDnsResolver');
const streamProxyRouter = require('../src/routes/streamProxy');

const { fetchRangeBuf } = streamProxyRouter;

jest.spyOn(adaptiveDnsResolver, 'lookup').mockImplementation((host, opts, cb) => {
  cb(null, [{ address: '93.184.216.34', family: 4 }]);
});

const URL_ = 'https://cdn.public-cdn.com/video/big.mp4';
const PIECE = 64 * 1024;

/** An endless body (think "1 GB file") that records what was pulled. */
function endlessBody(stats, signal) {
  return new ReadableStream({
    start(controller) {
      if (signal) signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
    pull(controller) {
      stats.pulled += PIECE;
      controller.enqueue(new Uint8Array(PIECE).fill(0x41));
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
}

/** A body that never delivers a byte (stalled upstream). */
function stalledBody(signal) {
  return new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
}

let fetchSpy;
beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch');
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(adaptiveDnsResolver, 'lookup').mockImplementation((host, opts, cb) => {
    cb(null, [{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('fetchRangeBuf', () => {
  const never = new AbortController().signal;

  test('rejects a 200 answer to a sub-range that does not start at 0, without buffering it', async () => {
    const stats = { pulled: 0, cancelled: false };
    fetchSpy.mockImplementation(async (url, init) => new Response(endlessBody(stats, init.signal), { status: 200 }));

    await expect(fetchRangeBuf(URL_, 1048576, 2097151, {}, never)).rejects.toMatchObject({ statusCode: 200 });
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(PIECE);
  });

  test('a 200 to a range starting at 0 is read only up to the requested length', async () => {
    const stats = { pulled: 0, cancelled: false };
    fetchSpy.mockImplementation(async (url, init) => new Response(endlessBody(stats, init.signal), { status: 200 }));

    const buf = await fetchRangeBuf(URL_, 0, 1048575, {}, never);

    expect(buf.length).toBe(1048576);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(1048576 + PIECE);
  });

  test('a 206 that over-delivers is capped to e - s + 1 bytes', async () => {
    const stats = { pulled: 0, cancelled: false };
    fetchSpy.mockImplementation(async (url, init) => new Response(endlessBody(stats, init.signal), {
      status: 206,
      headers: { 'content-range': 'bytes 100-199/999999999' },
    }));

    const buf = await fetchRangeBuf(URL_, 100, 199, {}, never);

    expect(buf.length).toBe(100);
    expect(stats.cancelled).toBe(true);
  });

  test('a 206 for a different range than requested is rejected', async () => {
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array(10), {
      status: 206,
      headers: { 'content-range': 'bytes 0-9/100' },
    }));

    await expect(fetchRangeBuf(URL_, 50, 59, {}, never)).rejects.toMatchObject({ statusCode: 206 });
  });

  test('a well-formed 206 is returned byte for byte', async () => {
    fetchSpy.mockImplementation(async () => new Response(Buffer.from('abcdefghij'), {
      status: 206,
      headers: { 'content-range': 'bytes 10-19/100' },
    }));

    const buf = await fetchRangeBuf(URL_, 10, 19, {}, never);
    expect(buf.toString()).toBe('abcdefghij');
  });

  test('a stalled chunk is cut by its own deadline', async () => {
    const deadline = new AbortController();
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    fetchSpy.mockImplementation(async (url, init) => new Response(stalledBody(init.signal), { status: 206 }));

    const pending = fetchRangeBuf(URL_, 0, 1048575, {}, never);
    await new Promise((r) => setImmediate(r));
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Number));
    expect(timeoutSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(20000);
  });

  test('a client abort still propagates through the combined signal', async () => {
    const client = new AbortController();
    fetchSpy.mockImplementation(async (url, init) => new Response(stalledBody(init.signal), { status: 206 }));

    const pending = fetchRangeBuf(URL_, 0, 99, {}, client.signal);
    await new Promise((r) => setImmediate(r));
    client.abort();

    await expect(pending).rejects.toMatchObject({ __expected: true });
  });
});

describe('/api/fastmp4 against an upstream that ignores Range', () => {
  let server;
  let port;

  beforeAll((done) => {
    const app = express();
    app.use(streamProxyRouter);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll((done) => { server.close(done); });

  test('streams only the first chunk-sized window and never buffers the whole file', async () => {
    const bodies = [];
    fetchSpy.mockImplementation(async (url, init) => {
      const stats = { pulled: 0, cancelled: false, range: init.headers.Range };
      bodies.push(stats);
      return new Response(endlessBody(stats, init.signal), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    });

    const received = await new Promise((resolve) => {
      let bytes = 0;
      const req = http.get({ host: '127.0.0.1', port, path: `/api/fastmp4?url=${encodeURIComponent(URL_)}&concurrency=4` }, (res) => {
        res.on('data', (c) => { bytes += c.length; });
        res.on('end', () => resolve(bytes));
        res.on('error', () => resolve(bytes));
        res.on('aborted', () => resolve(bytes));
      });
      req.on('error', () => resolve(-1));
    });

    // Chunk 0 (starting at byte 0) is legitimately served from the 200 body;
    // the next chunk gets a 200 for a non-zero offset and the stream stops.
    expect(received).toBe(1024 * 1024);
    for (const stats of bodies) {
      expect(stats.cancelled).toBe(true);
      expect(stats.pulled).toBeLessThanOrEqual(1024 * 1024 + PIECE);
    }
    // The probe drained at most one piece.
    expect(bodies[0].range).toBe('bytes=0-0');
    expect(bodies[0].pulled).toBe(PIECE);
  });
});
