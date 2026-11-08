'use strict';

/**
 * Options for the /api -> internal resolver proxy (http-proxy-middleware v4).
 *
 * v3+ dropped the legacy `onError` / `logLevel` options and silently ignores
 * them: errors go through `on.error`, logging through `logger`. With the old
 * keys the custom handler never ran and the library's default answered a
 * resolver outage with a 504 echoing the request URL.
 *
 * Kept in its own CommonJS module (no http-proxy-middleware import) so it can
 * be unit tested; the package itself is ESM-only.
 */

const RESOLVER_DOWN_MESSAGE = 'Bad Gateway: Internal stream resolver is not responding.';

function onResolverProxyError(err, req, res) {
  console.error('[Proxy Error] Failed to proxy /api request to internal resolver:', err && err.message);
  if (!res) return;
  // `res` is a net.Socket for upgrade requests; there is no HTTP response to write.
  if (typeof res.writeHead !== 'function') {
    if (typeof res.destroy === 'function') res.destroy();
    return;
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  if (typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(502).send(RESOLVER_DOWN_MESSAGE);
    return;
  }
  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(RESOLVER_DOWN_MESSAGE);
}

function resolverProxyOptions(resolverPort) {
  return {
    target: `http://127.0.0.1:${resolverPort}/api`,
    changeOrigin: true,
    xfwd: true,
    on: { error: onResolverProxyError },
  };
}

module.exports = { resolverProxyOptions, onResolverProxyError, RESOLVER_DOWN_MESSAGE };
