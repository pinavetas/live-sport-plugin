'use strict';

const { rewriteHlsPlaylist, preprobeManifestSegments, isTikTokCloakedSegment } = require('../src/services/HlsRewriteService');
const byteRangeSigner = require('../src/services/ByteRangeSigner');
const segmentLengthService = require('../src/services/SegmentLengthService');

describe('rewriteHlsPlaylist — TikTok ByteRange Injection', () => {
  const manifestUrl = 'https://lb22.strmd.st/hotel/stream/event/1/playlist.m3u8';

  beforeAll(() => {
    segmentLengthService.autoProbe = false;
  });

  afterAll(() => {
    segmentLengthService.autoProbe = true;
  });

  test('isTikTokCloakedSegment identifies cloaked segment URLs', () => {
    expect(isTikTokCloakedSegment('https://cdn.example.com/chunk_1.image')).toBe(true);
    expect(isTikTokCloakedSegment('https://p16-common-sign.tiktokcdn-us.com/tos/segment_1.ts')).toBe(true);
    expect(isTikTokCloakedSegment('https://byteoversea.com/live/chunk.mp4')).toBe(true);
    expect(isTikTokCloakedSegment('https://normal-cdn.example.com/segment_1.ts')).toBe(false);
  });

  test('injects #EXT-X-BYTERANGE:<length>@42 and hands the CDN URI to the player', () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXTINF:6.000,',
      'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg1.image',
      '#EXTINF:4.500,',
      'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg2.image'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl, {
      referer: 'https://embed.st/',
      origin: 'https://embed.st',
      absoluteAddonBaseUrl: 'https://nuviosports.xyz'
    });

    const lines = rewritten.split('\n');

    // Verify first segment has #EXT-X-BYTERANGE injected
    const byteRangeIndex1 = lines.findIndex(l => l.startsWith('#EXT-X-BYTERANGE:'));
    expect(byteRangeIndex1).toBeGreaterThan(0);
    expect(lines[byteRangeIndex1]).toMatch(/^#EXT-X-BYTERANGE:\d+@42$/);

    // Verify segment URI line immediately follows
    const uriLine1 = lines[byteRangeIndex1 + 1];
    // The player must talk to the CDN itself. The signed /api/hls/resource hop
    // is gone by default: Media3 DefaultHttpDataSource does not follow the
    // cross-protocol (http addon -> https CDN) 307 it used to answer with.
    expect(uriLine1).toBe('https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg1.image');
    expect(rewritten).not.toContain('/api/hls/resource');
  });

  test('TIKTOK_SEGMENT_MODE=redirect still emits a signed 307 hop', () => {
    const saved = process.env.TIKTOK_SEGMENT_MODE;
    process.env.TIKTOK_SEGMENT_MODE = 'redirect';
    try {
      const rawM3u8 = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXTINF:6.000,',
        'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg1.image'
      ].join('\n');

      const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl, {
        referer: 'https://embed.st/',
        origin: 'https://embed.st',
        absoluteAddonBaseUrl: 'https://nuviosports.xyz'
      });

      const outLines = rewritten.split('\n');
      const brIndex = outLines.findIndex(l => l.startsWith('#EXT-X-BYTERANGE:'));
      expect(brIndex).toBeGreaterThan(0);
      const uriLine = outLines[brIndex + 1];
      expect(uriLine).toMatch(/^https:\/\/nuviosports\.xyz\/api\/hls\/resource\/[^/]+\/media\.ts\?psig=/);

      const match = uriLine.match(/\/api\/hls\/resource\/([^/]+)\/media\.ts\?psig=([^&\s]+)/);
      expect(match).not.toBeNull();
      const decoded = byteRangeSigner.verifySegmentToken(match[1], decodeURIComponent(match[2]));
      expect(decoded).not.toBeNull();
      expect(decoded.url).toBe('https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg1.image');
      expect(decoded.referer).toBe(`https://embed.st/`);
      expect(decoded.prefixBytes).toBe(42);
    } finally {
      if (saved === undefined) delete process.env.TIKTOK_SEGMENT_MODE;
      else process.env.TIKTOK_SEGMENT_MODE = saved;
    }
  });

  test('does not duplicate #EXT-X-BYTERANGE if manifest already contains it', () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      '#EXTINF:6.000,',
      '#EXT-X-BYTERANGE:500000@42',
      'https://p16-common-sign.tiktokcdn-us.com/seg1.image'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl);
    const count = (rewritten.match(/#EXT-X-BYTERANGE/g) || []).length;
    expect(count).toBe(1);
  });

  test('leaves non-TikTok MPEG-TS segments direct without byte-range injection', () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:4.000,',
      'https://standard-cdn.example.com/live/seg1.ts'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl);
    expect(rewritten).not.toContain('#EXT-X-BYTERANGE');
    expect(rewritten).toContain('https://standard-cdn.example.com/live/seg1.ts');
  });

  test('preserves master playlist stream-inf variants', () => {
    const masterM3u8 = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
      '1080p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      '720p/index.m3u8'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(masterM3u8, manifestUrl, {
      referer: 'https://embed.st/',
      origin: 'https://embed.st'
    });

    expect(rewritten).toContain('/api/manifest?url=https%3A%2F%2Flb22.strmd.st%2Fhotel%2Fstream%2Fevent%2F1%2F1080p%2Findex.m3u8');
    expect(rewritten).toContain('/api/manifest?url=https%3A%2F%2Flb22.strmd.st%2Fhotel%2Fstream%2Fevent%2F1%2F720p%2Findex.m3u8');
  });

  test('preprobeManifestSegments probes and caches exact segment sizes', async () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:6.000,',
      'https://p16-common-sign.tiktokcdn-us.com/tos/probe_test_seg.image'
    ].join('\n');

    const probeSpy = jest.spyOn(segmentLengthService, 'probeContentLength').mockResolvedValue(2345678);

    await preprobeManifestSegments(rawM3u8, manifestUrl, {
      referer: 'https://embed.st/',
      origin: 'https://embed.st'
    });

    expect(probeSpy).toHaveBeenCalledWith(
      'https://p16-common-sign.tiktokcdn-us.com/tos/probe_test_seg.image',
      expect.objectContaining({ referer: 'https://embed.st/' })
    );

    // Verify cache has probed length
    segmentLengthService.setCachedLength('https://p16-common-sign.tiktokcdn-us.com/tos/probe_test_seg.image', 2345678);
    expect(segmentLengthService.hasValidLength('https://p16-common-sign.tiktokcdn-us.com/tos/probe_test_seg.image')).toBe(true);

    const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl);
    expect(rewritten).toContain('#EXT-X-BYTERANGE:2345678@42');

    probeSpy.mockRestore();
  });

  test('preprobeManifestSegments bounds probes to the latest 4 live-edge segments', async () => {
    const segments = [];
    for (let i = 1; i <= 10; i++) {
      segments.push('#EXTINF:6.000,');
      segments.push(`https://p16-common-sign.tiktokcdn-us.com/tos/probe_seg_${i}.image`);
    }
    const rawM3u8 = ['#EXTM3U', '#EXT-X-VERSION:3', ...segments].join('\n');

    const probeSpy = jest.spyOn(segmentLengthService, 'probeContentLength').mockResolvedValue(1000000);

    await preprobeManifestSegments(rawM3u8, manifestUrl, {
      referer: 'https://embed.st/',
      origin: 'https://embed.st'
    });

    // Out of 10 segments, only the freshest 4 (7, 8, 9, 10) on the live edge must be probed
    expect(probeSpy).toHaveBeenCalledTimes(4);
    expect(probeSpy).toHaveBeenCalledWith('https://p16-common-sign.tiktokcdn-us.com/tos/probe_seg_7.image', expect.anything());
    expect(probeSpy).toHaveBeenCalledWith('https://p16-common-sign.tiktokcdn-us.com/tos/probe_seg_8.image', expect.anything());
    expect(probeSpy).toHaveBeenCalledWith('https://p16-common-sign.tiktokcdn-us.com/tos/probe_seg_9.image', expect.anything());
    expect(probeSpy).toHaveBeenCalledWith('https://p16-common-sign.tiktokcdn-us.com/tos/probe_seg_10.image', expect.anything());

    probeSpy.mockRestore();
  });
});
