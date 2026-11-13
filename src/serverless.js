'use strict';

/**
 * serverless.js - runtime glue for Vercel Functions.
 *
 * The add-on was built as a long-running server: an in-memory catalog filled by
 * a background sync, cron jobs, and files under ./data. A Vercel Function only
 * runs while it serves a request, starts with an empty /tmp, and is frozen
 * after the response unless the work is registered with waitUntil(). Several
 * instances run at once and each starts empty; a full sync takes 20-50s. This
 * module adapts the parts that matter:
 *
 *  - CDN: catalog, meta and manifest responses get a Vercel CDN policy with
 *    stale-while-revalidate, so clients are answered from the edge while the
 *    function refreshes in the background (streams are excluded: their URLs
 *    carry short-lived upstream tokens).
 *  - Shared catalog: the catalog is shared by every instance instead of each
 *    one syncing its own. After a sync the cache file is published gzipped to
 *    the Vercel Runtime Cache (regional, fast, free tier: 1M read / 200K write
 *    units of 8 KB a month) and, at most every couple of hours, to Vercel Blob
 *    as the durable copy (the Runtime Cache may evict it). A stale instance
 *    first adopts a newer shared catalog; only when that is stale too does it
 *    sync, under a lease, so one instance refreshes while the others keep
 *    serving and pick up its result.
 *  - Cold start: a catalog/meta/stream request on an empty instance restores
 *    the shared catalog (Runtime Cache, then Blob). With none anywhere it
 *    either syncs (lease holder) or waits, bounded, for the holder's result.
 *  - Background work: a sync or upload still running when a response ends is
 *    handed to waitUntil() so the instance is not frozen halfway.
 *
 * Every shared-cache step fails open: when the Runtime Cache is unavailable or
 * paused (Hobby quota), an instance syncs on its own as before.
 *
 * Off Vercel (VERCEL unset) none of this is mounted and the server keeps its
 * normal listen + cron behaviour.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const IS_SERVERLESS = !!process.env.VERCEL;

// Requests that are useless against an empty catalog.
const DATA_ROUTE = /^\/(?:[^/]+\/)?(?:catalog|meta|stream)\//;
// Responses the CDN may serve stale while revalidating.
const CDN_SWR_ROUTE = /^\/(?:[^/]+\/)?(?:(?:catalog|meta)\/.+|manifest\.json)$/;

const DEFAULT_COLD_START_WAIT_MS = 50000;
const DEFAULT_CDN_SWR_SECONDS = Number(process.env.CDN_STALE_WHILE_REVALIDATE_S) || 3600;

const SNAPSHOT_PATH = process.env.CATALOG_SNAPSHOT_PATH || 'catalog/matches_cache.json.gz';
// A shared catalog older than this is not worth serving: wait for a fresh sync.
const SNAPSHOT_MAX_AGE_MS = Number(process.env.CATALOG_SNAPSHOT_MAX_AGE_MS) || 6 * 60 * 60 * 1000;
const SNAPSHOT_LOAD_TIMEOUT_MS = 10000;

const DEFAULTS = {
  // How old the catalog may get before an instance refreshes it. Longer than
  // the 10 min a long-running server uses: every sync costs Active CPU and
  // Runtime Cache write units, both capped on Hobby.
  revalidateMs: 20 * 60 * 1000,
  // A stale instance looks at the shared catalog at most this often.
  checkIntervalMs: 60 * 1000,
  // Sync lease: longer than the slowest sync seen (~50s); a holder that dies
  // blocks the others for at most this long.
  leaseMs: 3 * 60 * 1000,
  // Wait before re-reading a lease just written, to see whether another
  // instance wrote over it (the Runtime Cache has no compare-and-set).
  leaseSettleMs: 300,
  // How often a waiting cold instance looks for the lease holder's result.
  pollMs: 2000,
  // Durable Blob copy: Hobby includes 2,000 uploads a month.
  blobMinIntervalMs: 2 * 60 * 60 * 1000
};

const RUNTIME_NAMESPACE = 'live-sports';
const DATA_KEY = 'catalog-data-v1';
const META_KEY = 'catalog-meta-v1';
const LEASE_KEY = 'catalog-sync-lease-v1';
// Runtime Cache item limit is 2 MB; keep a margin for the JSON envelope.
const RUNTIME_MAX_ITEM_BYTES = 1900 * 1024;

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

function envMs(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

/** Which Runtime Cache backend @vercel/functions will use here (for the logs). */
function runtimeCacheBackend(env = process.env) {
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    if (ctx && ctx.cache) return 'vercel-request-context';
  } catch (_) {}
  if (env.RUNTIME_CACHE_ENDPOINT && env.RUNTIME_CACHE_HEADERS) return 'vercel-endpoint';
  return 'in-memory';
}

/**
 * The catalog shared by every instance: Runtime Cache (fast) + Blob (durable),
 * plus the sync lease that lets one instance refresh it at a time.
 *
 * @param {object} deps
 * @param {object} deps.cacheService  CacheService (cacheFilePath, lastFetchTime, reloadFromDisk, isStale)
 * @param {object} deps.cronService   CronService (syncNow, inflightSync, syncBackoffUntil)
 * @param {object} [deps.runtimeCache] getCache()-like { get, set, delete }
 * @param {object} [deps.blob]        @vercel/blob-like { get, put }
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {string} [deps.instanceId]
 * @param {object} [deps.options]     overrides for DEFAULTS
 */
function createSharedCatalog({
  cacheService,
  cronService,
  runtimeCache,
  blob,
  env = process.env,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  instanceId = crypto.randomBytes(6).toString('hex'),
  options = {}
}) {
  const opts = {
    ...DEFAULTS,
    revalidateMs: envMs(env, 'SERVERLESS_CATALOG_REVALIDATE_MS', DEFAULTS.revalidateMs),
    blobMinIntervalMs: envMs(env, 'CATALOG_SNAPSHOT_MIN_INTERVAL_MS', DEFAULTS.blobMinIntervalMs),
    ...options
  };
  const blobEnabled = !!(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);
  const blobStore = () => blob || require('@vercel/blob');
  let runtimeInstance = runtimeCache || null;
  let backendLogged = !!runtimeCache;
  const runtime = () => {
    if (!runtimeInstance) runtimeInstance = require('@vercel/functions').getCache({ namespace: RUNTIME_NAMESPACE });
    if (!backendLogged) {
      backendLogged = true;
      console.log(`[Serverless] Shared catalog cache backend: ${runtimeCacheBackend(env)} (instance ${instanceId})`);
    }
    return runtimeInstance;
  };

  // Runtime Cache calls never throw into the sync paths: on failure the
  // caller behaves as if nothing were shared.
  async function rcGet(key) {
    try { return await runtime().get(key); } catch (err) {
      console.warn(`[Serverless] Runtime cache read failed (${key}):`, err.message);
      return null;
    }
  }
  async function rcSet(key, value, ttlMs) {
    try {
      await runtime().set(key, value, { ttl: Math.max(1, Math.round(ttlMs / 1000)) });
      return true;
    } catch (err) {
      console.warn(`[Serverless] Runtime cache write failed (${key}):`, err.message);
      return false;
    }
  }
  async function rcDelete(key) {
    try { await runtime().delete(key); } catch (_) {}
  }

  const localTimestamp = () => Number(cacheService.lastFetchTime) || 0;
  const ageMin = (ts) => Math.round((now() - ts) / 60000);

  /**
   * Installs a gzipped cache file when it is recent and newer than what this
   * instance has. Returns true when the catalog was replaced.
   */
  function install(gz, source) {
    const json = zlib.gunzipSync(gz);
    // The file starts with {"schemaVersion":N,"timestamp":T,...}: read T
    // without parsing the whole catalog twice.
    const ts = /"timestamp":(\d+)/.exec(json.subarray(0, 200).toString('utf8'));
    const timestamp = ts ? Number(ts[1]) : 0;
    if (!timestamp || now() - timestamp > SNAPSHOT_MAX_AGE_MS) return false;
    if (timestamp <= localTimestamp() && !catalogIsEmpty(cacheService)) return false;

    const file = cacheService.cacheFilePath;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.shared.${process.pid}.${now()}`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
    cacheService.reloadFromDisk();
    if (catalogIsEmpty(cacheService)) return false;
    console.log(`[Serverless] Adopted shared catalog from ${source} (synced ${ageMin(timestamp)} min ago)`);
    if (typeof cronService.prewarmCatalogMemo === 'function') cronService.prewarmCatalogMemo();
    return true;
  }

  async function installFromRuntime() {
    const data = await rcGet(DATA_KEY);
    if (!data || typeof data.gz !== 'string') return false;
    if (Number(data.timestamp) <= localTimestamp() && !catalogIsEmpty(cacheService)) return false;
    return install(Buffer.from(data.gz, 'base64'), 'runtime cache');
  }

  async function installFromBlob() {
    if (!blobEnabled) return false;
    const res = await blobStore().get(SNAPSHOT_PATH, { access: 'private', useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return false;
    const gz = Buffer.from(await new Response(res.stream).arrayBuffer());
    if (!install(gz, 'blob')) return false;
    // Seed the Runtime Cache so the next cold instance skips the Blob read.
    await putRuntime(gz, localTimestamp());
    return true;
  }

  async function putRuntime(gz, timestamp) {
    const encoded = gz.toString('base64');
    if (encoded.length > RUNTIME_MAX_ITEM_BYTES) {
      console.warn(`[Serverless] Catalog too large for the runtime cache (${Math.round(encoded.length / 1024)} KB)`);
      return false;
    }
    const prev = await rcGet(META_KEY);
    // Data before meta: an instance that sees the new meta finds the new data.
    if (!(await rcSet(DATA_KEY, { timestamp, gz: encoded }, SNAPSHOT_MAX_AGE_MS))) return false;
    await rcSet(META_KEY, {
      timestamp,
      blobSavedAt: (prev && Number(prev.blobSavedAt)) || 0,
      by: instanceId
    }, SNAPSHOT_MAX_AGE_MS);
    return true;
  }

  let coldRestore = null;
  let blobTried = false;
  /**
   * Fills an empty instance from the shared catalog: Runtime Cache first, then
   * (once per instance) Blob. Resolves true when the catalog is now filled.
   */
  function restoreCold() {
    if (!coldRestore) {
      coldRestore = (async () => {
        if (await installFromRuntime()) return true;
        if (blobTried) return false;
        blobTried = true;
        return installFromBlob();
      })().catch((err) => {
        console.warn('[Serverless] Shared catalog restore failed:', err.message);
        return false;
      }).finally(() => { coldRestore = null; });
    }
    return coldRestore;
  }

  /** Adopts the shared catalog when another instance published a newer one. */
  async function pullIfNewer() {
    const meta = await rcGet(META_KEY);
    if (!meta || !(Number(meta.timestamp) > localTimestamp())) return false;
    try {
      return await installFromRuntime();
    } catch (err) {
      console.warn('[Serverless] Shared catalog pull failed:', err.message);
      return false;
    }
  }

  /**
   * Best-effort lease: the Runtime Cache has no compare-and-set, so write, wait
   * and re-read. Two instances can still both win a tight race; the cost is
   * one duplicate sync. When the cache keeps nothing (unavailable or paused)
   * the lease is granted, so syncing never stalls on it.
   */
  async function tryAcquireLease() {
    const current = await rcGet(LEASE_KEY);
    if (current && current.holder !== instanceId && Number(current.until) > now()) return false;
    await rcSet(LEASE_KEY, { holder: instanceId, until: now() + opts.leaseMs }, opts.leaseMs);
    await sleep(opts.leaseSettleMs);
    const check = await rcGet(LEASE_KEY);
    return !check || check.holder === instanceId;
  }

  async function releaseLease() {
    const current = await rcGet(LEASE_KEY);
    if (current && current.holder === instanceId) await rcDelete(LEASE_KEY);
  }

  /** Syncs under the lease; the lease is released only when the sync ends. */
  function leasedSync() {
    return Promise.resolve(cronService.syncNow()).finally(() => releaseLease());
  }

  let publishing = null;
  let lastBlobPutAt = 0;
  /**
   * Publishes this instance's catalog after a sync: Runtime Cache every time,
   * Blob when its copy is older than blobMinIntervalMs.
   */
  async function publish() {
    const timestamp = localTimestamp();
    if (!timestamp || catalogIsEmpty(cacheService)) return 'skipped';
    const gz = zlib.gzipSync(fs.readFileSync(cacheService.cacheFilePath));
    // Runtime Cache writes fail silently (the client only logs), so read the
    // record back to know whether other instances can see this catalog.
    const meta = (await putRuntime(gz, timestamp)) ? await rcGet(META_KEY) : null;
    const sharedOk = !!meta && Number(meta.timestamp) === timestamp;
    console.log(sharedOk
      ? `[Serverless] Shared catalog published (${Math.round(gz.length / 1024)} KB)`
      : '[Serverless] Catalog not visible in the runtime cache; instances refresh on their own');

    if (!blobEnabled) return sharedOk ? 'shared' : 'failed';
    // The shared record covers every instance; the local one still throttles
    // this instance when the Runtime Cache is unavailable.
    const blobSavedAt = Math.max((meta && Number(meta.blobSavedAt)) || 0, lastBlobPutAt);
    if (now() - blobSavedAt < opts.blobMinIntervalMs) return sharedOk ? 'shared' : 'failed';
    lastBlobPutAt = now(); // claim before awaiting so overlapping publishes upload once
    try {
      await blobStore().put(SNAPSHOT_PATH, gz, {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/gzip',
        cacheControlMaxAge: 60
      });
      if (sharedOk) await rcSet(META_KEY, { ...(meta || { timestamp }), blobSavedAt: now() }, SNAPSHOT_MAX_AGE_MS);
      console.log(`[Serverless] Saved catalog to blob (${Math.round(gz.length / 1024)} KB)`);
      return 'shared+blob';
    } catch (err) {
      lastBlobPutAt = 0;
      console.warn('[Serverless] Catalog blob upload failed:', err.message);
      return sharedOk ? 'shared' : 'failed';
    }
  }

  let refreshing = null;
  let lastCheckAt = 0;
  /**
   * Replaces CronService.ensureFresh() on Vercel. When this instance's catalog
   * is stale: adopt a newer shared one; if that is stale too, sync under the
   * lease, or leave it to the instance that holds it.
   * @returns {Promise<string>} what happened (for tests and logs)
   */
  function refresh() {
    if (refreshing) return refreshing;
    if (!cacheService.isStale(opts.revalidateMs)) return Promise.resolve('fresh');
    if (now() - lastCheckAt < opts.checkIntervalMs) return Promise.resolve('throttled');
    if (cronService.inflightSync) return Promise.resolve('syncing');
    if (now() < (Number(cronService.syncBackoffUntil) || 0)) return Promise.resolve('backoff');
    lastCheckAt = now();

    refreshing = (async () => {
      if (await pullIfNewer() && !cacheService.isStale(opts.revalidateMs)) return 'pulled';
      if (!(await tryAcquireLease())) return 'leased-elsewhere';
      console.log('[Serverless] Catalog stale everywhere; this instance refreshes it');
      await leasedSync();
      return 'synced';
    })().catch((err) => {
      console.warn('[Serverless] Catalog refresh failed:', err.message);
      return 'failed';
    }).finally(() => { refreshing = null; });
    keepAlive(refreshing);
    return refreshing;
  }

  let firstSync = null;
  /**
   * Cold start with nothing shared: sync when this instance gets the lease,
   * otherwise wait for the holder's result. Bounded by `deadline`; a sync
   * still running then continues in the background.
   */
  function syncOrWait(deadline) {
    if (firstSync) return firstSync;
    firstSync = (async () => {
      while (now() < deadline) {
        if (await tryAcquireLease()) {
          const sync = leasedSync();
          keepAlive(sync);
          await withTimeout(sync, Math.max(0, deadline - now()));
          return 'synced';
        }
        await sleep(opts.pollMs);
        if (await pullIfNewer()) return 'pulled';
      }
      return 'timeout';
    })().catch((err) => {
      console.warn('[Serverless] Cold-start sync failed:', err.message);
      return 'failed';
    }).finally(() => { firstSync = null; });
    return firstSync;
  }

  return {
    enabled: true,
    blobEnabled,
    instanceId,
    options: opts,
    restoreCold,
    pullIfNewer,
    tryAcquireLease,
    releaseLease,
    publish() {
      if (!publishing) {
        publishing = publish().catch((err) => {
          console.warn('[Serverless] Catalog publish failed:', err.message);
          return 'failed';
        }).finally(() => { publishing = null; });
      }
      return publishing;
    },
    refresh,
    syncOrWait
  };
}

/**
 * Wires the shared catalog into CronService:
 *  - every sync that changed the catalog publishes it before it counts as done
 *    (so the lease is released only once the result is visible to others), and
 *    logs its CPU cost (Active CPU is capped on Hobby);
 *  - ensureFresh(), called by the catalog handlers, goes through refresh().
 */
function installSharedCatalog({ cronService, cacheService, shared }) {
  if (!shared) return;
  const runSync = cronService.runSync.bind(cronService);
  cronService.runSync = async function runSyncShared(...args) {
    const before = cacheService.lastFetchTime;
    const cpu = process.cpuUsage();
    const startedAt = Date.now();
    try {
      return await runSync(...args);
    } finally {
      if (cacheService.lastFetchTime !== before) {
        const used = process.cpuUsage(cpu);
        console.log(`[Serverless] Sync took ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ` +
          `${((used.user + used.system) / 1e6).toFixed(1)}s CPU`);
        const published = shared.publish();
        keepAlive(published);
        await published;
      }
    }
  };
  cronService.ensureFresh = function ensureFreshShared() {
    shared.refresh();
  };
}

/**
 * Express middleware for the serverless runtime.
 * @param {{ cronService: object, cacheService: object, shared?: object, maxWaitMs?: number, now?: () => number }} deps
 */
function createColdStartGate({ cronService, cacheService, shared = null, maxWaitMs = DEFAULT_COLD_START_WAIT_MS, now = Date.now }) {
  return async function coldStartGate(req, res, next) {
    // Whatever sync is running when this response ends must be allowed to finish.
    res.on('finish', () => keepAlive(cronService.inflightSync));

    if (!DATA_ROUTE.test(requestPath(req)) || !catalogIsEmpty(cacheService)) return next();

    const deadline = now() + maxWaitMs;
    if (shared) {
      // Fast path: the catalog another instance already shared.
      const restored = await withTimeout(shared.restoreCold(), SNAPSHOT_LOAD_TIMEOUT_MS);
      if (restored && !catalogIsEmpty(cacheService)) return next();
      await shared.syncOrWait(deadline);
      return next();
    }

    let timer = null;
    try {
      const sync = cronService.syncNow();
      keepAlive(sync);
      await Promise.race([
        sync,
        new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - now())); })
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
  RUNTIME_KEYS: { DATA_KEY, META_KEY, LEASE_KEY },
  keepAlive,
  createCdnCachePolicy,
  createSharedCatalog,
  installSharedCatalog,
  createColdStartGate,
  applyServerlessFsDefaults,
  runtimeCacheBackend
};
