'use strict';

/**
 * serverless.js - runtime glue for Vercel Functions.
 *
 * The add-on was built as a long-running server: an in-memory catalog filled by
 * a background sync, cron jobs, and files under ./data. A Vercel Function only
 * runs while it serves a request, starts with an empty /tmp, and is frozen
 * after the response unless the work is registered with waitUntil(). This
 * module adapts the parts that matter:
 *
 *  - Cold start: a catalog/meta/stream request that arrives while the catalog
 *    is empty waits (bounded) for the first sync instead of answering with an
 *    empty list.
 *  - Background work: a sync still running when a response ends is handed to
 *    waitUntil() so the instance is not frozen halfway through it. Later
 *    refreshes are traffic-driven by CronService.ensureFresh() (SWR).
 *
 * Off Vercel (VERCEL unset) none of this is mounted and the server keeps its
 * normal listen + cron behaviour.
 */

const IS_SERVERLESS = !!process.env.VERCEL;

// Requests that are useless against an empty catalog.
const DATA_ROUTE = /^\/(?:[^/]+\/)?(?:catalog|meta|stream)\//;

const DEFAULT_COLD_START_WAIT_MS = 50000;

/**
 * Extends the current invocation until `promise` settles. A no-op outside a
 * Vercel request context.
 * @param {Promise<unknown>|null|undefined} promise
 */
function keepAlive(promise) {
  if (!promise || !IS_SERVERLESS) return;
  try {
    require('@vercel/functions').waitUntil(promise);
  } catch (_) {
    // Not inside a Vercel request (local tests): nothing to extend.
  }
}

function catalogIsEmpty(cacheService) {
  try {
    const matches = cacheService.getMatchesReadOnly();
    return !Array.isArray(matches) || matches.length === 0;
  } catch (_) {
    return true;
  }
}

/**
 * Express middleware for the serverless runtime.
 * @param {{ cronService: object, cacheService: object, maxWaitMs?: number }} deps
 */
function createColdStartGate({ cronService, cacheService, maxWaitMs = DEFAULT_COLD_START_WAIT_MS }) {
  return async function coldStartGate(req, res, next) {
    // Whatever sync is running when this response ends must be allowed to finish.
    res.on('finish', () => keepAlive(cronService.inflightSync));

    if (!DATA_ROUTE.test(req.path) || !catalogIsEmpty(cacheService)) return next();

    let timer = null;
    try {
      const sync = cronService.syncNow();
      keepAlive(sync);
      await Promise.race([
        sync,
        new Promise((resolve) => { timer = setTimeout(resolve, maxWaitMs); })
      ]);
    } catch (_) {
      // A failed sync leaves the catalog empty; the handlers answer as usual.
    } finally {
      if (timer) clearTimeout(timer);
    }
    next();
  };
}

/**
 * Points every file the app writes at /tmp, the only writable path on Vercel.
 * Explicit env values win. Call before the app modules are required.
 * @param {NodeJS.ProcessEnv} [env]
 */
function applyServerlessFsDefaults(env = process.env) {
  const base = env.SERVERLESS_DATA_DIR || '/tmp/live-sports';
  if (!env.DATA_DIR) env.DATA_DIR = base;
  if (!env.LIVE_OVERLAY_FILE) env.LIVE_OVERLAY_FILE = `${base}/live_overlay.json`;
  if (!env.TEAM_LOGOS_CACHE_FILE) env.TEAM_LOGOS_CACHE_FILE = `${base}/team_logos_cache.json`;
  return env;
}

module.exports = {
  IS_SERVERLESS,
  DATA_ROUTE,
  keepAlive,
  createColdStartGate,
  applyServerlessFsDefaults
};
