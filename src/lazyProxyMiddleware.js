'use strict';

/**
 * Lazy wrapper around http-proxy-middleware's createProxyMiddleware().
 *
 * http-proxy-middleware v4 is ESM-only. Node >= 22.12 can require() it, but not
 * every runtime can: the Vercel Functions module loader throws ERR_REQUIRE_ESM,
 * and a static require at the top of index.js took the whole app down at
 * startup. The real middleware is imported with import() on first use instead.
 * The /api resolver proxy is only reached when resolver routing is enabled
 * (ResolverTrustPolicy), so most deployments never load the library at all.
 *
 * @param {object} options             http-proxy-middleware options
 * @param {() => Promise<{createProxyMiddleware: Function}>} [importer]
 *        module loader, injectable for tests
 * @returns {import('express').RequestHandler}
 */
function createProxyMiddleware(options, importer = () => import('http-proxy-middleware')) {
  let proxy = null;
  let loading = null;

  return function lazyProxy(req, res, next) {
    if (proxy) return proxy(req, res, next);
    if (!loading) {
      loading = Promise.resolve()
        .then(importer)
        .then((mod) => {
          proxy = mod.createProxyMiddleware(options);
          return proxy;
        });
      // A failed import is retried on the next request instead of sticking.
      loading.catch(() => { loading = null; });
    }
    loading.then((handler) => handler(req, res, next), next);
  };
}

module.exports = { createProxyMiddleware };
