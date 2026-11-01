'use strict';

const StreamedWasmPool = require('../src/services/StreamedWasmPool');

jest.setTimeout(20000);

describe('StreamedWasmPool (Worker Thread WASM Decryption)', () => {
  let pool;

  beforeAll(() => {
    pool = StreamedWasmPool;
  });

  afterAll(async () => {
    if (pool && typeof pool.destroy === 'function') {
      await pool.destroy();
    }
  });

  test('should initialize worker pool with configured worker count', () => {
    expect(pool).toBeDefined();
    expect(pool.workers.length).toBeGreaterThanOrEqual(1);
  });

  test('should handle invalid embed targets gracefully without throwing', async () => {
    const res = await pool.resolveWasmStream('dummy', 'dummy-event', '1', 'https://embed.st/embed/dummy/dummy-event/1', 2000);
    expect(res === null || typeof res === 'string').toBe(true);
  });

  test('should handle concurrent resolution calls without crashing', async () => {
    const calls = [
      pool.resolveWasmStream('hotel', 'surfers-paradise-race-1', '1', 'https://embed.st/embed/hotel/surfers-paradise-race-1/1', 3000),
      pool.resolveWasmStream('hotel', 'surfers-paradise-race-1', '2', 'https://embed.st/embed/hotel/surfers-paradise-race-1/2', 3000)
    ];

    const results = await Promise.all(calls);
    expect(results).toHaveLength(2);
    results.forEach(r => {
      expect(r === null || typeof r === 'string').toBe(true);
    });
  });
});
