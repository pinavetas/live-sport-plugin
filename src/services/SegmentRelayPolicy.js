'use strict';

/**
 * SegmentRelayPolicy — when the addon must relay HLS media segments.
 *
 * Playlists are proxied by /api/manifest, but segments normally go straight
 * from the CDN to the player (zero server bandwidth). Many CDNs only serve a
 * segment when the request carries the embed page's Referer / Origin /
 * User-Agent. The add-on hands those to the client as behaviorHints.proxyHeaders,
 * yet Stremio ignores proxyHeaders for live HLS (published notWebReady:false),
 * so its player hits the CDN bare and gets 403. Nuvio/ExoPlayer applies them.
 *
 * The playlist request itself tells which kind of client is asking: a client
 * that applies proxyHeaders sends the upstream Referer on it. When it does not,
 * the same client will not send it to the CDN either, so segments of that
 * playlist are routed through /api/hlschunk, which adds the headers.
 *
 * SEGMENT_RELAY: "auto" (default) as above, "always", or "off" (never relay).
 */

function originOf(value) {
  try { return new URL(String(value)).origin; } catch (_) { return ''; }
}

/**
 * BYTE_RELAY — whether this deployment may carry media bytes at all
 * (/api/hlschunk, /api/mp4proxy, /api/fastmp4 and the DASH media routes).
 * "on" / "off"; by default off on Vercel, whose plans meter function egress
 * and pause the whole project once the allowance is spent, and on elsewhere.
 * When off, no playlist is rewritten to relay segments, whatever SEGMENT_RELAY
 * says, and the relay routes refuse every request.
 */
function byteRelayEnabled(env = process.env) {
  const value = String(env.BYTE_RELAY || '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(value)) return true;
  if (['off', 'false', '0', 'no'].includes(value)) return false;
  return !env.VERCEL;
}

// Routes whose responses are media bytes fetched from upstream.
const BYTE_RELAY_PATHS = ['/api/hlschunk', '/api/mp4proxy', '/api/fastmp4', '/api/dash/init.mp4', '/api/dash/segment.mp4'];

/** Express middleware: refuses the media relay routes when BYTE_RELAY is off. */
function byteRelayGate(env = process.env) {
  return function byteRelayGateMiddleware(req, res, next) {
    if (byteRelayEnabled(env)) return next();
    const p = req.path || String(req.url || '').split('?')[0];
    if (!BYTE_RELAY_PATHS.includes(p)) return next();
    res.status(403).set('Cache-Control', 'no-store').type('text/plain').send('Media relay is disabled on this deployment.');
  };
}

function relayMode(env = process.env) {
  if (!byteRelayEnabled(env)) return 'off';
  const mode = String(env.SEGMENT_RELAY || 'auto').trim().toLowerCase();
  return mode === 'always' || mode === 'off' ? mode : 'auto';
}

/**
 * @param {object} req  Express request for /api/manifest
 * @param {object} [env]
 * @returns {boolean} true when this playlist's segments must be relayed
 */
function shouldRelaySegments(req, env = process.env) {
  const mode = relayMode(env);
  if (mode === 'off') return false;
  if (mode === 'always') return true;

  // Only streams that declare an upstream Referer need it on the CDN.
  const upstreamReferer = req && req.query ? req.query.referer : '';
  if (typeof upstreamReferer !== 'string' || !upstreamReferer) return false;
  const wanted = originOf(upstreamReferer);
  if (!wanted) return false;

  const headers = (req && req.headers) || {};
  const sentReferer = originOf(headers.referer || headers.referrer || '');
  const sentOrigin = typeof headers.origin === 'string' ? headers.origin : '';
  // The client is applying the provider headers: let it fetch the CDN itself.
  if (sentReferer === wanted || sentOrigin === wanted) return false;
  return true;
}

const DNS_CHECK_TIMEOUT_MS = 1500;
const MAX_HOSTS_CHECKED = 3;

/**
 * Hosts of the media URIs in a playlist (first few, playlists excluded).
 */
function segmentHosts(playlistBody, baseUrl) {
  const hosts = [];
  const lines = String(playlistBody || '').split(/\r?\n/);
  for (let i = 0; i < lines.length && hosts.length < MAX_HOSTS_CHECKED; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (i > 0 && lines[i - 1].trim().startsWith('#EXT-X-STREAM-INF')) continue;
    try {
      const host = new URL(line, baseUrl).hostname;
      if (host && !hosts.includes(host)) hosts.push(host);
    } catch (_) {}
  }
  return hosts;
}

/**
 * True when a media host of this playlist is blocked by the local ISP's DNS
 * (sinkhole / NXDOMAIN, detected by the adaptive resolver). A player on the
 * same network resolves it the same way and cannot reach it, so its segments
 * must be relayed. Unknown hosts get one bounded adaptive lookup first.
 */
async function playlistHasIspBlockedHost(playlistBody, baseUrl, resolver = require('./AdaptiveDnsResolver'), env = process.env) {
  if (relayMode(env) === 'off' || !resolver || typeof resolver.isPoisonedHost !== 'function') return false;
  for (const host of segmentHosts(playlistBody, baseUrl)) {
    if (resolver.isPoisonedHost(host)) return true;
    if (typeof resolver.lookup !== 'function') continue;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, DNS_CHECK_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        resolver.lookup(host, { all: true }, () => { clearTimeout(timer); resolve(); });
      } catch (_) { clearTimeout(timer); resolve(); }
    });
    if (resolver.isPoisonedHost(host)) return true;
  }
  return false;
}

module.exports = {
  shouldRelaySegments,
  relayMode,
  playlistHasIspBlockedHost,
  segmentHosts,
  byteRelayEnabled,
  byteRelayGate,
  BYTE_RELAY_PATHS
};
