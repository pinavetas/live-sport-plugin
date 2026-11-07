'use strict';

/**
 * Direct handler for Nuvio Collection sub-catalogs (nuvio_sports_replays_*).
 *
 * Collection folders query these catalogs by ID; they are answered here,
 * ahead of the SDK router, so the main manifest does not need a home-screen
 * row for every one of them.
 */

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

/**
 * Parses a Stremio extra segment ("skip=20&genre=A%26B") into an object.
 * Works on the RAW (still percent-encoded) segment so an encoded "&" or "="
 * inside a value cannot split it, splits each pair on the first "=" only, and
 * decodes every key/value on its own so one malformed escape cannot drop the
 * other extras.
 */
function parseExtraSegment(raw) {
  const extra = {};
  if (typeof raw !== 'string' || !raw) return extra;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = safeDecode(part.slice(0, eq));
    const value = safeDecode(part.slice(eq + 1));
    if (key && value) extra[key] = value;
  }
  return extra;
}

// Express has already decoded req.params.extra, so read the encoded segment
// from the request path instead (the SDK router does the same).
function rawExtraSegment(req) {
  const p = typeof req.path === 'string' ? req.path : '';
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (last && last.endsWith('.json')) return last.slice(0, -5);
  return req.params.extra || '';
}

function createReplaySubcatalogHandler({ handleCatalog, decodeConfigSegment, applyCompactParams }) {
  return async function replaySubcatalogHandler(req, res, next) {
    const { type, id } = req.params;
    if (!id || !id.startsWith('nuvio_sports_replays_') || id === 'nuvio_sports_replays') return next();

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      const config = applyCompactParams(
        req.params.config ? decodeConfigSegment(req.params.config) : {},
        req.query
      );
      const extra = req.params.extra ? parseExtraSegment(rawExtraSegment(req)) : {};
      const result = await handleCatalog(type, id, extra, config);
      if (result && Number.isInteger(result.cacheMaxAge)) {
        const swr = Number.isInteger(result.staleRevalidate) ? result.staleRevalidate : result.cacheMaxAge * 2;
        res.setHeader('Cache-Control', `max-age=${result.cacheMaxAge}, stale-while-revalidate=${swr}, public`);
      }
      return res.json(result);
    } catch (err) {
      // An async Express 4 handler that throws never answers; the client would
      // hang until its own timeout. Answer with an empty page instead and keep
      // it cacheable only briefly so a recovered catalog shows up quickly.
      console.error(`[Catalog] Sub-catalog ${id} failed:`, err && err.message ? err.message : err);
      if (res.headersSent) return undefined;
      res.setHeader('Cache-Control', 'max-age=30, public');
      return res.status(200).json({ metas: [] });
    }
  };
}

module.exports = { createReplaySubcatalogHandler, parseExtraSegment };
