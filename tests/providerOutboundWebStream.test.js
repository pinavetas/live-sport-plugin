'use strict';

// nodeToWebStream replaces Readable.toWeb() for guarded streaming responses.
// With toWeb, a 'data' event that reached the adapter after the web stream was
// cancelled or errored threw ERR_INVALID_STATE ("Controller is already
// closed") from the event handler, an uncaughtException that killed the addon.

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { nodeToWebStream } = require('../src/services/ProviderOutbound');

/** Minimal Readable stand-in that keeps emitting even after destroy(). */
function stubbornSource() {
  const src = new EventEmitter();
  src.pause = jest.fn();
  src.resume = jest.fn();
  src.destroy = jest.fn();
  return src;
}

async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

describe('nodeToWebStream', () => {
  test('a chunk arriving after cancel() is dropped instead of throwing', async () => {
    const src = stubbornSource();
    const reader = nodeToWebStream(src).getReader();
    src.emit('data', Buffer.from('first'));
    const { value } = await reader.read();
    expect(Buffer.from(value).toString()).toBe('first');

    await reader.cancel();
    expect(src.destroy).toHaveBeenCalled();
    expect(() => src.emit('data', Buffer.from('late'))).not.toThrow();
  });

  test('a chunk arriving after the source errored is dropped instead of throwing', async () => {
    const src = stubbornSource();
    const reader = nodeToWebStream(src).getReader();
    src.emit('error', new Error('deadline'));
    await expect(reader.read()).rejects.toThrow('deadline');
    expect(() => src.emit('data', Buffer.from('late'))).not.toThrow();
  });

  test('a chunk arriving after end is dropped instead of throwing', async () => {
    const src = stubbornSource();
    const reader = nodeToWebStream(src).getReader();
    src.emit('end');
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(() => src.emit('data', Buffer.from('late'))).not.toThrow();
  });

  test('delivers every byte of a real stream and then ends', async () => {
    const src = new PassThrough();
    const web = nodeToWebStream(src);
    const payload = Buffer.alloc(256 * 1024, 7);
    setImmediate(() => {
      for (let i = 0; i < payload.length; i += 16 * 1024) src.write(payload.subarray(i, i + 16 * 1024));
      src.end();
    });
    const out = await readAll(web);
    expect(out.length).toBe(payload.length);
    expect(out.equals(payload)).toBe(true);
  });

  test('a body closed before end surfaces as an error, not a clean end', async () => {
    const src = new PassThrough();
    const reader = nodeToWebStream(src).getReader();
    setImmediate(() => src.destroy());
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
  });

  test('bounded read then cancel on a real stream destroys the source', async () => {
    const src = new PassThrough();
    const reader = nodeToWebStream(src).getReader();
    setImmediate(() => { for (let i = 0; i < 64; i++) src.write(Buffer.alloc(4096, 1)); });
    let total = 0;
    while (total < 16 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    await reader.cancel();
    expect(src.destroyed).toBe(true);
  });
});
