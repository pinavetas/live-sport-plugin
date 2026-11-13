'use strict';

// Shared L2 cache operations are private worker-to-resolver APIs. The public
// /api proxy must not expose cache claims, writes, deletes, or stats.
const PUBLIC_RESOLVER_PATHS = new Set(['/stream', '/health']);

function publicResolverApiGate(req, res, next) {
  if (PUBLIC_RESOLVER_PATHS.has(req.path)) return next();
  return res.status(404).send('Not found');
}

module.exports = publicResolverApiGate;
