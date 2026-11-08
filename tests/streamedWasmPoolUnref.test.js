'use strict';

const { EventEmitter } = require('events');
const exportedPool = require('../src/services/StreamedWasmPool');

// The pool is a module-level singleton that spawns worker threads on require.
// If those workers stay ref'd, every process that merely loads the container
// (each Jest worker, one-off scripts) can never exit on its own.

class FakeWorker extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
  }

  on(event, listener) {
    this.log.push(`on:${event}`);
    return super.on(event, listener);
  }

  unref() {
    this.log.push('unref');
  }

  postMessage() {}

  terminate() {
    return Promise.resolve(0);
  }
}

describe('StreamedWasmPool worker liveness', () => {
  const StreamedWasmPool = exportedPool.StreamedWasmPool;

  beforeAll(async () => {
    await exportedPool.destroy();
  });

  test('unrefs each worker after its message listener is attached', async () => {
    const log = [];
    const pool = new StreamedWasmPool({ poolSize: 1, workerFactory: () => new FakeWorker(log) });
    try {
      expect(log).toContain('unref');
      // Attaching a 'message' listener re-refs a real Worker's port, so unref must come last.
      expect(log.indexOf('unref')).toBeGreaterThan(log.lastIndexOf('on:message'));
    } finally {
      await pool.destroy();
    }
  });

  test('the real singleton does not keep the event loop alive', async () => {
    const pool = new StreamedWasmPool({ poolSize: 1 });
    try {
      const active = process.getActiveResourcesInfo();
      expect(active).not.toContain('Worker');
      expect(active).not.toContain('MessagePort');
    } finally {
      await pool.destroy();
    }
  });
});
