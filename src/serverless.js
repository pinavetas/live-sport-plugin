'use strict';

/**
 * serverless.js - runtime glue for Vercel Functions.
 *
 * The add-on was built as a long-running server: an in-memory catalog filled by
 * a background sync, cron jobs, and files under ./data. A Vercel Function only
 * runs while it serves a request, starts with an empty /tmp, and is frozen
 * after the response unless the work is registered with waitUntil(). Every new
 * instance starts empty, and a full sync takes ~50s there. This module adapts
 * the parts that matter:
 *
 *  - CDN: catalog, meta and manifest responses get a Vercel CDN policy with
 *    stale-while-revalidate, so clients are answered from the edge while the
 *    function refreshes in the background (streams are excluded: their URLs
 *    carry short-lived upstream tokens).
 *  - Catalog snapshot: after a sync, the catalog cache file is stored gzipped
 *    in Vercel Blob (private). A cold instance restores it in ~1-2s instead of
 *    running its own sync; CronService.ensureFresh() then refreshes it in the
 *    background once it is stale. Off when no Blob store is connected.
 *  - Cold start without a snapshot: a catalog/meta/stream request waits
 *    (bounded) for the first sync instead of answering with an empty list.
 *  - Background work: a sync or snapshot upload still running when a response
 *    ends is handed to waitUntil() so the instance is not frozen halfway.
 *
 * Off Vercel (VERCEL unset) none of this is mounted and the server keeps its
 * normal listen + cron behaviour.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const IS_SERVERLESS = !!process.env.VERCEL;

// Requests that are useless against an empty catalog.
const DATA_ROUTE = /^\/(?:[^/]+\/)?(?:catalog|meta|stream)\//;
// Responses the CDN may serve stale while revalidating.
const CDN_SWR_ROUTE = /^\/(?:[^/]+\/)?(?:(?:catalog|meta)\/.+|manifest\.json)$/;

const DEFAULT_COLD_START_WAIT_MS = 50000;
const DEFAULT_CDN_SWR_SECONDS = Number(process.env.CDN_STALE_WHILE_REVALIDATE_S) || 3600;

const SNAPSHOT_PATH = process.env.CATALOG_SNAPSHOT_PATH || 'catalog/matches_cache.json.gz';
// A snapshot older than this is not worth serving: wait for a fresh sync.
const SNAPSHOT_MAX_AGE_MS = Number(process.env.CATALOG_SNAPSHOT_MAX_AGE_MS) || 6 * 60 * 60 * 1000;
// Upload at most this often (Blob writes are metered).
const SNAPSHOT_MIN_INTERVAL_MS = Number(process.env.CATALOG_SNAPSHOT_MIN_INTERVAL_MS) || 30 * 60 * 1000;
const SNAPSHOT_LOAD_TIMEOUT_MS = 10000;

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

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })
  ]).finally(() => clearTimeout(timer));
}

function requestPath(req) {
  return req.path || String(req.url || '').split('?')[0];
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/**
 * Adds a Vercel CDN policy with stale-while-revalidate to cacheable catalog,
 * meta and manifest responses. The freshness window is the response's own
 * public max-age, so per-catalog TTLs set by the handlers are kept.
 * @param {{ swrSeconds?: number }} [opts]
 */
function createCdnCachePolicy({ swrSeconds = DEFAULT_CDN_SWR_SECONDS } = {}) {
  return function cdnCachePolicy(req, res, next) {
    if (!CDN_SWR_ROUTE.test(requestPath(req))) return next();
    const writeHead = res.writeHead;
    res.writeHead = function patchedWriteHead(...args) {
      try {
        const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
        const inline = typeof args[1] === 'object' ? args[1] : (typeof args[2] === 'object' ? args[2] : null);
        const cc = String(headerValue(inline, 'cache-control') || res.getHeader('Cache-Control') || '');
        const maxAge = /(?:^|[,\s])max-age=(\d+)/i.exec(cc);
        if (status === 200 && maxAge && /\bpublic\b/i.test(cc) && !/no-store|no-cache|private/i.test(cc) &&
            !res.getHeader('Vercel-CDN-Cache-Control')) {
          res.setHeader('Vercel-CDN-Cache-Control', `max-age=${maxAge[1]}, stale-while-revalidate=${swrSeconds}`);
        }
      } catch (_) {
        // Never let the cache policy break a response.
      }
      return writeHead.apply(this, args);
    };
    next();
  };
}

/**
 * Catalog snapshot in Vercel Blob: the CacheService file, gzipped.
 * @param {{ cacheService: object, blob?: object, env?: NodeJS.ProcessEnv, now?: () => number }} deps
 */
function createCatalogSnapshot({ cacheService, blob, env = process.env, now = Date.now }) {
  const enabled = !!(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);
  const store = () => blob || require('@vercel/blob');
  let knownTimestamp = 0;
  let loading = null;

  async function load() {
    const res = await store().get(SNAPSHOT_PATH, { access: 'private', useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return false;
    const json = zlib.gunzipSync(Buffer.from(await new Response(res.stream).arrayBuffer()));
    // The file starts with {"schemaVersion":N,"timestamp":T,...}: read T
    // without parsing the whole catalog twice.
    const ts = /"timestamp":(\d+)/.exec(json.subarray(0, 200).toString('utf8'));
    const timestamp = ts ? Number(ts[1]) : 0;
    if (!timestamp || now() - timestamp > SNAPSHOT_MAX_AGE_MS) return false;

    const file = cacheService.cacheFilePath;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.snapshot.${process.pid}.${now()}`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
    cacheService.reloadFromDisk();
    if (catalogIsEmpty(cacheService)) return false;
    knownTimestamp = timestamp;
    console.log(`[Serverless] Restored catalog snapshot from ${Math.round((now() - timestamp) / 60000)} min ago`);
    return true;
  }

  async function save() {
    const ts = cacheService.lastFetchTime || 0;
    if (!enabled || !ts || catalogIsEmpty(cacheService)) return 'skipped';
    if (knownTimestamp && ts - knownTimestamp < SNAPSHOT_MIN_INTERVAL_MS) return 'skipped';
    knownTimestamp = ts; // claim before awaiting so overlapping syncs upload once
    const gz = zlib.gzipSync(fs.readFileSync(cacheService.cacheFilePath));
    await store().put(SNAPSHOT_PATH, gz, {
      access: 'private',
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'application/gzip',
      cacheControlMaxAge: 60
    });
    console.log(`[Serverless] Saved catalog snapshot (${Math.round(gz.length / 1024)} KB)`);
    return 'saved';
  }

  return {
    enabled,
    /** Restores the snapshot once per instance; resolves true when the catalog is now filled. */
    loadOnce() {
      if (!enabled) return Promise.resolve(false);
      if (!loading) {
        loading = load().catch((err) => {
          console.warn('[Serverless] Catalog snapshot restore failed:', err.message);
          return false;
        });
      }
      return loading;
    },
    save() {
      return save().catch((err) => {
        knownTimestamp = 0;
        console.warn('[Serverless] Catalog snapshot upload failed:', err.message);
        return 'failed';
      });
    },
    get knownTimestamp() { return knownTimestamp; }
  };
}

/**
 * Uploads a fresh snapshot after every sync that changed the catalog.
 * Wraps the instance's runSync, which every sync path (syncNow, ensureFresh,
 * requestSync) goes through.
 */
function installSnapshotOnSync({ cronService, cacheService, snapshot }) {
  if (!snapshot || !snapshot.enabled) return;
  const runSync = cronService.runSync.bind(cronService);
  cronService.runSync = async function runSyncWithSnapshot(...args) {
    const before = cacheService.lastFetchTime;
    try {
      return await runSync(...args);
    } finally {
      if (cacheService.lastFetchTime !== before) keepAlive(snapshot.save());
    }
  };
}

/**
 * Express middleware for the serverless runtime.
 * @param {{ cronService: object, cacheService: object, snapshot?: object, maxWaitMs?: number }} deps
 */
function createColdStartGate({ cronService, cacheService, snapshot = null, maxWaitMs = DEFAULT_COLD_START_WAIT_MS }) {
  return async function coldStartGate(req, res, next) {
    // Whatever sync is running when this response ends must be allowed to finish.
    res.on('finish', () => keepAlive(cronService.inflightSync));

    if (!DATA_ROUTE.test(requestPath(req)) || !catalogIsEmpty(cacheService)) return next();

    // Fast path: restore the last catalog another instance stored.
    if (snapshot && snapshot.enabled) {
      const restored = await withTimeout(snapshot.loadOnce(), SNAPSHOT_LOAD_TIMEOUT_MS);
      if (restored && !catalogIsEmpty(cacheService)) return next();
    }

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
  CDN_SWR_ROUTE,
  SNAPSHOT_PATH,
  keepAlive,
  createCdnCachePolicy,
  createCatalogSnapshot,
  installSnapshotOnSync,
  createColdStartGate,
  applyServerlessFsDefaults
};
