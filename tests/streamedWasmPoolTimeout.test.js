'use strict';

// Stub the module's eager singleton workers before importing it; the lifecycle
// tests below use their own fake workers and must not start real provider WASM.
jest.mock('worker_threads', () => {
  const { EventEmitter } = require('events');
  return { Worker: class extends EventEmitter { terminate() { return Promise.resolve(0); } } };
});
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

  test('unexpected worker exit settles its in-flight job and dispatches queued work to replacement', async () => {
    const first = pool.resolveWasmStream('provider', 'event', '1', 'https://example.com/embed/1', 5000);
    await new Promise(resolve => setImmediate(resolve));

    const deadWorker = workers[0];
    const firstJobId = deadWorker.messages[0].jobId;
    const second = pool.resolveWasmStream('provider', 'event', '2', 'https://example.com/embed/2', 5000);

    // A native crash can produce an exit without a preceding error event.
    deadWorker.emit('exit', 1);

    // Don't wait for the original five-second timeout; ownership has ended.
    await expect(first).resolves.toBeNull();
    expect(pool.pendingResolvers.has(firstJobId)).toBe(false);
    expect(pool.jobQueue).toHaveLength(1);

    await new Promise(resolve => setImmediate(resolve));
    expect(workers).toHaveLength(2);
    const replacement = workers[1];
    expect(replacement.messages).toHaveLength(1);
    expect(replacement.messages[0].jobId).not.toBe(firstJobId);

    replacement.respond(replacement.messages[0].jobId);
    await expect(second).resolves.toBe('https://example.com/live.m3u8');
    expect(pool.pendingResolvers.size).toBe(0);
  });

  test('exit after an error does not re-settle an already failed worker job', async () => {
    const current = pool.resolveWasmStream('provider', 'event', '1', 'https://example.com/embed/1', 5000);
    await new Promise(resolve => setImmediate(resolve));

    const worker = workers[0];
    const jobId = worker.messages[0].jobId;
    worker.emit('error', new Error('fixture worker crash'));
    await expect(current).resolves.toBeNull();
    expect(pool.pendingResolvers.has(jobId)).toBe(false);

    worker.emit('exit', 1);
    await new Promise(resolve => setImmediate(resolve));
    expect(workers).toHaveLength(2);
    expect(pool.pendingResolvers.size).toBe(0);
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
