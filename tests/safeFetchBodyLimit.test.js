'use strict';

const { Readable } = require('node:stream');
const { readLimitedBody } = require('../src/impitClient');

describe('readLimitedBody', () => {
  test('caps an Undici-style Node stream and reports truncation', async () => {
    const body = Readable.from([Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')]);
    const result = await readLimitedBody(body, 5);
    expect(result.buffer.toString('utf8')).toBe('abcde');
    expect(result.buffer.byteLength).toBe(5);
    expect(result.truncated).toBe(true);
  });

  test('caps a Fetch-style ReadableStream and reports truncation', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abc'));
        controller.enqueue(new TextEncoder().encode('def'));
        controller.close();
      },
    });
    const result = await readLimitedBody(body, 4);
    expect(result.buffer.toString('utf8')).toBe('abcd');
    expect(result.buffer.byteLength).toBe(4);
    expect(result.truncated).toBe(true);
  });

  test('does not mark a body truncated when it ends exactly at the limit', async () => {
    const body = Readable.from([Buffer.from('abcd')]);
    const result = await readLimitedBody(body, 4);
    expect(result.buffer.toString('utf8')).toBe('abcd');
    expect(result.truncated).toBe(false);
  });

  test('treats a missing body as an empty complete response', async () => {
    const result = await readLimitedBody(null, 4);
    expect(result.buffer.byteLength).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
