'use strict';

const { EventEmitter } = require('events');
const exportedPool = require('../src/services/StreamedWasmPool');

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.terminated = false;
    setImmediate(() => this.emit('message', { type: 'ready' }));
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
    setImmediate(() => this.emit('exit', 1));
    return Promise.resolve(1);
  }

  respond(jobId, m3u8Url = 'https://example.com/live.m3u8') {
    this.emit('message', { jobId, m3u8Url });
  }
}

describe('StreamedWasmPool timeout lifecycle', () => {
  const StreamedWasmPool = exportedPool.StreamedWasmPool;
  let workers;
  let pool;

  beforeAll(async () => {
    // The module exports a live singleton; stop it before using isolated fake workers.
    await exportedPool.destroy();
  });

  beforeEach(() => {
    workers = [];
    pool = new StreamedWasmPool({
      poolSize: 1,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }
    });
  });

  afterEach(async () => {
    await pool.destroy();
  });

  test('removes a queued job when it times out before dispatch', async () => {
    const first = pool.resolveWasmStream('provider', 'event', '1', 'https://example.com/embed/1', 1000);
    await new Promise(resolve => setImmediate(resolve));

    const firstJobId = workers[0].messages[0].jobId;
    const second = pool.resolveWasmStream('provider', 'event', '2', 'https://example.com/embed/2', 20);

    await expect(second).resolves.toBeNull();
    expect(pool.jobQueue).toHaveLength(0);

    workers[0].respond(firstJobId);
    await expect(first).resolves.toBe('https://example.com/live.m3u8');
    expect(workers[0].messages.map(message => message.jobId)).toEqual([firstJobId]);
  });

  test('terminates an active worker on timeout and dispatches queued work to its replacement', async () => {
    const first = pool.resolveWasmStream('provider', 'event', '1', 'https://example.com/embed/1', 20);
    await new Promise(resolve => setImmediate(resolve));
    const firstWorker = workers[0];
    expect(firstWorker.messages).toHaveLength(1);

    const second = pool.resolveWasmStream('provider', 'event', '2', 'https://example.com/embed/2', 1000);

    await expect(first).resolves.toBeNull();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(firstWorker.terminated).toBe(true);
    expect(workers.length).toBeGreaterThanOrEqual(2);
    const replacement = workers[1];
    expect(replacement.messages).toHaveLength(1);

    replacement.respond(replacement.messages[0].jobId);
    await expect(second).resolves.toBe('https://example.com/live.m3u8');
  });
});
