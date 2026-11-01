'use strict';

// Preserve the raw query: it contains nested CDN tokens and the recovery key.
// Only the configured addon's HLS endpoint gets an extension for player inference.
function manifestPlaybackUrl(rawUrl, addonBaseUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
  try {
    const base = new URL(addonBaseUrl);
    const parsed = new URL(rawUrl, base);
    const endpoint = base.pathname.replace(/\/+$/, '') + '/api/manifest';
    if (parsed.origin !== base.origin || parsed.pathname !== endpoint) return rawUrl;
    const target = parsed.searchParams.get('url');
    if (!target) return rawUrl;
    if (new URL(target, base).pathname.toLowerCase().includes('.mpd')) return rawUrl;

    const suffix = rawUrl.search(/[?#]/);
    const path = suffix === -1 ? rawUrl : rawUrl.slice(0, suffix);
    if (!path.endsWith(endpoint)) return rawUrl;
    return path + '.m3u8' + (suffix === -1 ? '' : rawUrl.slice(suffix));
  } catch (_) {
    return rawUrl;
  }
}

module.exports = { manifestPlaybackUrl };
