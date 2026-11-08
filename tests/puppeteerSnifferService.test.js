'use strict';

process.env.NODE_ENV = 'test';

const PuppeteerSnifferService = require('../src/services/PuppeteerSnifferService');
const EmbedStProvider = require('../src/providers/EmbedStProvider');
const PpvStProvider = require('../src/providers/PpvStProvider');
const StreamEntity = require('../src/domain/StreamEntity');

describe('PuppeteerSnifferService', () => {
  test('isAvailable() returns false when ENABLE_PUPPETEER=false', () => {
    const orig = process.env.ENABLE_PUPPETEER;
    process.env.ENABLE_PUPPETEER = 'false';
    const sniffer = new PuppeteerSnifferService();
    expect(sniffer.isAvailable()).toBe(false);
    process.env.ENABLE_PUPPETEER = orig || 'true';
  });

  test('sniff() returns null for invalid or non-http URLs', async () => {
    const sniffer = new PuppeteerSnifferService();
    expect(await sniffer.sniff(null)).toBeNull();
    expect(await sniffer.sniff('')).toBeNull();
    expect(await sniffer.sniff('javascript:void(0)')).toBeNull();
  });

  test('sniff() spawns child process and parses structured JSON output', async () => {
    const mockPayload = {
      success: true,
      file: 'https://cdn.upstream.com/live/hls/master.m3u8',
      type: 'hls',
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/128',
        'Referer': 'https://embed.test/',
        'Origin': 'https://embed.test'
      }
    };

    const mockExec = jest.fn((execPath, args, opts, cb) => {
      expect(args[1]).toBe('https://embed.test/live/123');
      expect(args[2]).toBe('https://referer.test/');
      cb(null, JSON.stringify(mockPayload), '');
    });

    const sniffer = new PuppeteerSnifferService({
      execFn: mockExec
    });

    const result = await sniffer.sniff('https://embed.test/live/123', {
      referer: 'https://referer.test/',
      timeoutMs: 10000
    });

    expect(result).toBeDefined();
    expect(result.file).toBe('https://cdn.upstream.com/live/hls/master.m3u8');
    expect(result.type).toBe('hls');
    expect(result.headers['Referer']).toBe('https://embed.test/');
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  test('sniff() parses regex fallback format from child process stdout', async () => {
    const mockOutput = `
      Some noisy browser logs...
      {"file":"https://stream.provider.com/playlist.m3u8"}
    `;

    const mockExec = jest.fn((execPath, args, opts, cb) => {
      cb(null, mockOutput, '');
    });

    const sniffer = new PuppeteerSnifferService({
      execFn: mockExec
    });

    const result = await sniffer.sniff('https://embed.test/player');
    expect(result).toBeDefined();
    expect(result.file).toBe('https://stream.provider.com/playlist.m3u8');
    expect(result.type).toBe('hls');
  });

  test('sniff() coalesces concurrent requests via single-flight mechanism', async () => {
    let callCount = 0;
    const mockExec = jest.fn((execPath, args, opts, cb) => {
      callCount++;
      setTimeout(() => {
        cb(null, JSON.stringify({
          success: true,
          file: 'https://cdn.stream.com/live.m3u8'
        }), '');
      }, 50);
    });

    const sniffer = new PuppeteerSnifferService({
      execFn: mockExec
    });

    // Fire 5 simultaneous requests for the exact same URL
    const results = await Promise.all([
      sniffer.sniff('https://embed.singleflight.test/stream'),
      sniffer.sniff('https://embed.singleflight.test/stream'),
      sniffer.sniff('https://embed.singleflight.test/stream'),
      sniffer.sniff('https://embed.singleflight.test/stream'),
      sniffer.sniff('https://embed.singleflight.test/stream')
    ]);

    expect(callCount).toBe(1);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
    results.forEach(r => {
      expect(r.file).toBe('https://cdn.stream.com/live.m3u8');
    });
  });

  test('sniff() returns cached result within TTL without re-executing process', async () => {
    const mockExec = jest.fn((execPath, args, opts, cb) => {
      cb(null, JSON.stringify({
        success: true,
        file: 'https://cdn.cached.com/stream.m3u8'
      }), '');
    });

    const sniffer = new PuppeteerSnifferService({
      execFn: mockExec,
      cacheTtlMs: 60000
    });

    const res1 = await sniffer.sniff('https://embed.cache.test/1');
    const res2 = await sniffer.sniff('https://embed.cache.test/1');

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(res1.file).toBe('https://cdn.cached.com/stream.m3u8');
    expect(res2.file).toBe('https://cdn.cached.com/stream.m3u8');
  });

  test('resolveStream() emits direct StreamEntity with proxyHeaders (Zero Server Bandwidth Bleed)', async () => {
    const mockExec = jest.fn((execPath, args, opts, cb) => {
      cb(null, JSON.stringify({
        success: true,
        file: 'https://upstream-cdn.space/live/hls/chunklist.m3u8',
        type: 'hls',
        headers: {
          'Referer': 'https://embed.test/',
          'Origin': 'https://embed.test',
          'User-Agent': 'TestAgent/1.0'
        }
      }), '');
    });

    const sniffer = new PuppeteerSnifferService({
      execFn: mockExec
    });

    const stream = await sniffer.resolveStream('https://embed.test/live/999', {
      providerName: 'CustomEmbed',
      title: 'Arsenal vs Chelsea',
      referer: 'https://embed.test/'
    });

    expect(stream).toBeInstanceOf(StreamEntity);
    expect(stream.name).toBe('CustomEmbed');
    expect(stream.title).toContain('Arsenal vs Chelsea');
    expect(stream.url).toBe('https://upstream-cdn.space/live/hls/chunklist.m3u8');
    expect(stream.resolution).toBe('HD');

    // Verification of Zero Server Bandwidth Bleed: direct client player headers
    expect(stream.behaviorHints).toBeDefined();
    expect(stream.behaviorHints.proxyHeaders.request['Referer']).toBe('https://embed.test/');
    expect(stream.behaviorHints.proxyHeaders.request['Origin']).toBe('https://embed.test');
    expect(stream.url).not.toContain('/api/hlschunk');
    expect(stream.url).not.toContain('/api/fastmp4');
  });

  test('EmbedStProvider falls back to PuppeteerSniffer when WASM returns null', async () => {
    const mockSniffer = {
      isAvailable: () => true,
      resolveStream: jest.fn(async (url, opts) => {
        return new StreamEntity({
          name: 'EmbedSt',
          title: `[Direct] ${opts.title}`,
          url: 'https://cdn.sniffed.com/manifest.m3u8',
          behaviorHints: {
            proxyHeaders: {
              request: { Referer: 'https://embed.st/' }
            }
          },
          resolution: 'HD'
        });
      })
    };

    const provider = new EmbedStProvider({
      streamedWasmPool: {
        resolveWasmStream: async () => null // simulate WASM failing or returning null
      },
      puppeteerSniffer: mockSniffer
    });

    const streams = await provider.resolveStream('embed_123', 'football', 'Barcelona vs Real Madrid', {
      embedUrl: 'https://embed.st/embed/admin/el-clasico/1',
      referer: 'https://embed.st/'
    });

    expect(mockSniffer.resolveStream).toHaveBeenCalledWith(
      'https://embed.st/embed/admin/el-clasico/1',
      expect.objectContaining({
        referer: 'https://embed.st/',
        providerName: 'EmbedSt',
        title: 'Barcelona vs Real Madrid'
      })
    );

    expect(streams.some(s => s.url === 'https://cdn.sniffed.com/manifest.m3u8')).toBe(true);
  });

  test('PpvStProvider falls back to PuppeteerSniffer when WASM extraction fails', async () => {
    const mockSniffer = {
      isAvailable: () => true,
      resolveStream: jest.fn(async (url, opts) => {
        return new StreamEntity({
          name: 'PpvSt',
          title: `PpvSt (${opts.title})`,
          url: 'https://cdn.ppvsniffed.com/master.m3u8',
          behaviorHints: {
            proxyHeaders: {
              request: { Referer: 'https://embedindia.st/' }
            }
          },
          resolution: 'HD'
        });
      })
    };

    const provider = new PpvStProvider({
      puppeteerSniffer: mockSniffer
    });

    const streams = await provider.resolveStream('ppv_123', 'fighting', 'UFC 300', {
      embedUrl: 'https://embedindia.st/embed/ufc-300'
    });

    expect(mockSniffer.resolveStream).toHaveBeenCalledWith(
      'https://embedindia.st/embed/ufc-300',
      expect.objectContaining({
        providerName: 'PpvSt',
        title: 'UFC 300'
      })
    );

    expect(streams.some(s => s.url === 'https://cdn.ppvsniffed.com/master.m3u8')).toBe(true);
  });
});
