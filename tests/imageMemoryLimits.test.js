const fs = require('fs');
const zlib = require('zlib');

jest.mock('undici', () => ({ request: jest.fn() }));

// ── Minimal PNG builder: lets a test declare any dimensions cheaply ──────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 1-bit greyscale PNG; a 16384x16384 one is a few dozen KB on the wire. */
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth; colour type, compression, filter, interlace = 0
  const rowBytes = 1 + Math.ceil(width / 8);
  const idat = zlib.deflateSync(Buffer.alloc(rowBytes * height), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}
/** Valid PNG signature/IHDR followed by padding to `size` bytes (never decoded). */
function paddedPng(size) {
  const head = png(100, 100);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

function mockResponse(buffer, contentType = 'image/png') {
  return {
    statusCode: 200,
    headers: { 'content-type': contentType },
    body: {
      on() {},
      destroy() {},
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < buffer.length; i += 1024 * 1024) yield buffer.subarray(i, i + 1024 * 1024);
      }
    }
  };
}

function loadImageService(env = {}) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  let svc, undici;
  jest.isolateModules(() => {
    undici = require('undici');
    svc = require('../src/services/ImageService');
  });
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return { svc, request: undici.request };
}

const MB = 1024 * 1024;

describe('ImageService cache is bounded by total bytes', () => {
  it('defaults to a 64 MB cap and evicts least-recently-used entries to stay under it', async () => {
    const { svc, request } = loadImageService();
    expect(svc.CACHE_MAX_BYTES).toBe(64 * MB);
    const body = paddedPng(4 * MB);
    request.mockImplementation(async () => mockResponse(body));

    await svc.getImage('https://img.test/0.png');
    for (let i = 1; i < 30; i++) {
      await svc.getImage(`https://img.test/${i}.png`);
      await svc.getImage('https://img.test/0.png'); // keep #0 hot
    }

    const stats = svc.getCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(64 * MB);
    expect(stats.entries).toBe(16); // 16 x 4 MB = 64 MB, not 30 x 4 MB
    // #0 was used most recently, so LRU kept it; #1 was the coldest and went first.
    expect(svc.getCachedMeta('https://img.test/0.png')).not.toBeNull();
    expect(svc.getCachedMeta('https://img.test/1.png')).toBeNull();
    const before = request.mock.calls.length;
    await svc.getImage('https://img.test/0.png');
    expect(request.mock.calls.length).toBe(before);
  });

  it('honours IMAGE_CACHE_MAX_BYTES and still returns (but does not cache) an entry larger than the cap', async () => {
    const { svc, request } = loadImageService({ IMAGE_CACHE_MAX_BYTES: String(3 * MB) });
    expect(svc.CACHE_MAX_BYTES).toBe(3 * MB);
    request.mockImplementation(async (url) => mockResponse(paddedPng(url.includes('big') ? 4 * MB : 1 * MB)));

    const big = await svc.getImage('https://img.test/big.png');
    expect(big && big.buffer.length).toBe(4 * MB);
    expect(svc.getCacheStats()).toMatchObject({ entries: 0, bytes: 0 });

    for (let i = 0; i < 5; i++) await svc.getImage(`https://img.test/s${i}.png`);
    expect(svc.getCacheStats()).toMatchObject({ entries: 3, bytes: 3 * MB });
  });
});

describe('decoding fetched images is capped by limitInputPixels', () => {
  const huge = png(16384, 16384); // ~268 MP: sharp's default limit, ~1 GB as RGBA

  it('the crafted image is tiny on the wire but declares 16384x16384', () => {
    expect(huge.length).toBeLessThan(100 * 1024);
    const { svc } = loadImageService();
    expect(svc.parseImageDimensions(huge)).toEqual({ width: 16384, height: 16384 });
  });

  it('defaults to 4096*4096 and is configurable through IMAGE_MAX_INPUT_PIXELS', () => {
    expect(loadImageService().svc.sharpInputOptions()).toEqual({ limitInputPixels: 4096 * 4096 });
    expect(loadImageService({ IMAGE_MAX_INPUT_PIXELS: '1000000' }).svc.sharpInputOptions())
      .toEqual({ limitInputPixels: 1000000 });
  });

  it('sharp rejects the image with the shared options instead of decoding it', async () => {
    const sharp = require('sharp');
    const { svc } = loadImageService();
    await expect(sharp(huge, svc.sharpInputOptions()).resize({ width: 64 }).jpeg().toBuffer())
      .rejects.toThrow(/pixel limit/i);
  });

  it('getResizedImage refuses an oversized image gracefully (null -> caller serves the original bytes)', async () => {
    const { svc, request } = loadImageService();
    request.mockImplementation(async () => mockResponse(huge));
    expect(svc.exceedsPixelLimit({ width: 16384, height: 16384 })).toBe(true);
    await expect(svc.getResizedImage('https://img.test/bomb.png', 128)).resolves.toBeNull();
  });

  it('getResizedImage still resizes a normal image', async () => {
    const sharp = require('sharp');
    const normal = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } }).png().toBuffer();
    const { svc, request } = loadImageService();
    request.mockImplementation(async () => mockResponse(normal));
    const out = await svc.getResizedImage('https://img.test/ok.png', 128);
    expect(out && out.contentType).toBe('image/jpeg');
    expect((await sharp(out.buffer).metadata()).width).toBe(128);
  });

  it('the sharp limit also applies when the header parser cannot read the dimensions', async () => {
    const sharp = require('sharp');
    const { svc } = loadImageService({ IMAGE_MAX_INPUT_PIXELS: String(100 * 100) });
    const webp = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#000000' } }).webp().toBuffer();
    await expect(sharp(webp, svc.sharpInputOptions()).png().toBuffer()).rejects.toThrow(/pixel limit/i);
    expect(svc.exceedsPixelLimit({ width: null, height: null })).toBe(false);
  });
});

describe('index.js decode sites', () => {
  const source = fs.readFileSync(require.resolve('../src/index'), 'utf8');

  it('entryToDataUri drops oversized images and passes the decode limit to sharp', () => {
    const start = source.indexOf('async function entryToDataUri');
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toMatch(/imageService\.exceedsPixelLimit\(entry\)\) return null/);
    expect(body).toMatch(/sharp\(buffer, imageService\.sharpInputOptions\(\)\)/);
  });

  it('the /img embed card falls back to the placeholder when the image cannot be inlined', () => {
    expect(source).toMatch(/const imgUrl = await entryToDataUri\(entry\);\s*if \(!imgUrl\)/);
  });

  it('every sharp() call in index.js either rasterises our own SVG or carries the limit', () => {
    const calls = source.match(/sharp\((?!\)).*?\)\./g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/Buffer\.from\((svg|svgText)\)|sharpInputOptions\(\)/);
    }
  });
});
