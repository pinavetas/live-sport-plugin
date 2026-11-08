/**
 * YouTubeRedirect.js
 *
 * /watch never iframes YouTube; it redirects the client there instead. That
 * redirect must never take its target from the caller: substring checks such
 * as /youtube\.com/ match `https://evil.com/youtube.com` and
 * `https://youtube.com@evil.com`, which turned /watch into an open redirect.
 *
 * The only thing taken from the input is a validated 11-character video id;
 * the redirect target is always rebuilt on a fixed YouTube host.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

// Path prefixes that carry the id as the next segment: /embed/ID, /shorts/ID...
const ID_PATH_PREFIXES = new Set(['embed', 'v', 'e', 'shorts', 'live']);

function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value);
}

/**
 * Extract a YouTube video id from a bare id or a URL on a genuine YouTube host.
 * @param {*} input
 * @returns {string|null}
 */
function extractYouTubeVideoId(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (isVideoId(raw)) return raw;

  let parsed;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw
      : raw.startsWith('//') ? 'https:' + raw
      : 'https://' + raw;
    parsed = new URL(withScheme);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (SHORT_HOSTS.has(host)) {
    return isVideoId(segments[0]) ? segments[0] : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (segments[0] === 'watch') {
    const v = parsed.searchParams.get('v');
    return isVideoId(v) ? v : null;
  }
  if (ID_PATH_PREFIXES.has(segments[0]) && isVideoId(segments[1])) return segments[1];
  return null;
}

/** Canonical watch URL for an already-validated id, or null. */
function youtubeWatchUrl(videoId) {
  return isVideoId(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

module.exports = { extractYouTubeVideoId, youtubeWatchUrl, isVideoId };
