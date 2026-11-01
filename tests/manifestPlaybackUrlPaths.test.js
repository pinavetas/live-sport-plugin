'use strict';

// Playback URLs are published as /api/manifest.m3u8 (see ManifestPlaybackUrl),
// while provider/cached URLs keep the plain /api/manifest form. Anything that
// unwraps a proxy URL has to accept both, or it silently stops seeing the
// wrapped upstream.

const StreamResolveCache = require('../src/services/StreamResolveCache');

describe('proxy manifest URL forms', () => {
  const inner = 'https://cdn.example.invalid/live/index.m3u8?e=';
  const future = String(Math.floor((Date.now() + 600000) / 1000));

  test('token remaining time is read from the wrapped URL for both published paths', () => {
    const cache = new StreamResolveCache();
    const plain = cache._extractTokenRemainingMs(
      `https://addon.example.invalid/api/manifest?url=${encodeURIComponent(inner + future)}`
    );
    const suffixed = cache._extractTokenRemainingMs(
      `https://addon.example.invalid/api/manifest.m3u8?url=${encodeURIComponent(inner + future)}&rck=streamedpk%3Am%3As`
    );

    expect(plain).toBeGreaterThan(0);
    // Same upstream token, so the same remaining life; a miss here would mean
    // the suffixed form was never unwrapped and returned 0.
    expect(Math.abs(suffixed - plain)).toBeLessThan(5000);
  });

  test('a non-proxy URL is still read directly', () => {
    const cache = new StreamResolveCache();
    expect(cache._extractTokenRemainingMs(`${inner}${future}`)).toBeGreaterThan(0);
  });
});
