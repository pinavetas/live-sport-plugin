'use strict';

/**
 * WorkerBudget.js
 *
 * Budget-aware allocation across the Cloudflare worker pool.
 *
 * The pool used to be seven identical free workers (100k requests/day each,
 * hard stop, daily reset). Uniform random was optimal there: every member had
 * the same capacity, so an equal share was the optimal share, and all seven
 * exhausted at the same moment with nothing left unused.
 *
 * That fleet no longer exists. It is now six free workers plus one paid worker
 * (10M requests/month, billed above that, no hard stop). The capacities differ
 * by 3.33x and the reset periods differ (daily vs monthly), so an equal share
 * is no longer an optimal share — it starves the paid worker at 1/7 of traffic
 * while the free ones hit their wall.
 *
 * Policy implemented here:
 *   1. Random *within* the free tier, skipping any worker that has spent its
 *      daily cap. Keeps the even spread that worked on the homogeneous pool.
 *   2. Overflow to the paid worker once every free worker is at its cap.
 *   3. Nothing else: the caller decides the last resort (see the hlschunk
 *      fallback decision in HlsRewriteService).
 *
 * Two things make the counters honest:
 *
 *  - Live HLS re-serves a sliding window, so each playlist fetch re-emits the
 *    same ~6 segment URLs. Counting every emission inflates usage by roughly
 *    the window size and would flip to the paid tier at a fraction of real
 *    load. Emissions are deduped per segment URL for a short TTL.
 *  - PM2 runs in cluster mode (ecosystem.config.js), so every process keeps
 *    its own counters and would independently allow a full cap. The per-worker
 *    cap is divided by WORKER_INSTANCE_COUNT so the fleet-wide total stays put.
 *
 * Counts are estimates, biased in the safe direction: an emitted URL may never
 * be fetched by the player, so the recorded usage can only run ahead of real
 * usage. Overshooting moves traffic to the paid worker early; it never fails a
 * segment.
 *
 * Spent-worker detection (fire-and-forget probe):
 *  - Emission counting can only run ahead of real usage: a worker Cloudflare has
 *    already blocked (due to quota or rate-limiting) would keep receiving traffic
 *    until the local counter drains.
 *  - Trade-off: when a free worker's count reaches CF_PROBE_THRESHOLD (default
 *    0.8 × cap), a detached background HEAD request is sent to <worker>/.
 *    A 403, 429, or 503 response marks that worker spent for the UTC day,
 *    filtering it out of pick() immediately.
 *  - The paid worker is never probed. Network failures leave spent=false.
 */

// Six free workers. The paid worker is deliberately NOT in this list.
const DEFAULT_FREE_POOL = [
  'https://nuvio-proxy.odedararaj456.workers.dev',
  'https://nuvio-proxy3.raj-odedara.workers.dev',
  'https://spring-brook-5c1e.rajodedara456.workers.dev',
  'https://falling-unit-ffa6.rajcfproxy1.workers.dev',
  'https://falling-violet-3301.hansabenhodedara.workers.dev',
  'https://nameless-dawn-2ab8.abhi-munot01.workers.dev',
];

const DEFAULT_PAID_WORKER = 'https://nuvio-proxy2.rajodedara360.workers.dev';

// Documented plan limits, not guesses: 100k/day on Free, 10M/month included on
// the Workers Paid standard usage model.
const FREE_DAILY_LIMIT = 100000;
const PAID_MONTHLY_LIMIT = 10000000;
const PAID_HARD_LIMIT = 20000000;

const DEFAULTS = {
  freeCapRatio: 0.9, // stop at 90k of 100k so drift never turns into a hard stop
  paidSoftCapRatio: 0.95, // warn at 9.5M before 10M included billing starts
  paidHardLimit: 20000000, // absolute monthly ceiling (10M included + 10M burst allowance)
  probeThreshold: 0.8, // fraction of cap (0-1) to trigger background HEAD probe; >=1 disables
  dedupeTtlMs: 120000,
  dedupeMaxEntries: 20000,
  instances: 1,
  logIntervalMs: 300000,
};

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map(normalizeBaseUrl)
    .filter(Boolean);
}

function readNumber(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFlag(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).toLowerCase() !== 'off';
}

function utcDayKey(date) {
  return date.toISOString().slice(0, 10);
}

function utcMonthKey(date) {
  return date.toISOString().slice(0, 7);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return String(url);
  }
}

/**
 * Resolve pool configuration from an env bag. Kept pure so tests can pass a
 * literal object instead of mutating process.env.
 */
function resolveConfig(env = process.env, overrides = {}) {
  const paidWorker = normalizeBaseUrl(env.CF_PAID_WORKER_URL) || DEFAULT_PAID_WORKER;
  const configuredPool = parseList(env.CF_WORKER_POOL);
  const sourcePool = configuredPool.length ? configuredPool : DEFAULT_FREE_POOL;
  const instances = Math.max(
    1,
    Math.floor(readNumber(env.WORKER_INSTANCE_COUNT, DEFAULTS.instances))
  );

  // Invariant: the paid worker is never reachable through the random draw,
  // whatever CF_WORKER_POOL happens to contain.
  const seen = new Set();
  const freePool = [];
  for (const url of sourcePool) {
    if (url === paidWorker || seen.has(url)) continue;
    seen.add(url);
    freePool.push(url);
  }

  const freeCapPerProcess =
    overrides.freeCapPerProcess !== undefined
      ? overrides.freeCapPerProcess
      : Math.floor(
          (FREE_DAILY_LIMIT * readNumber(env.CF_FREE_CAP_RATIO, DEFAULTS.freeCapRatio)) /
            instances
        );

  const paidSoftRatio = readNumber(
    env.CF_PAID_SOFT_STOP_RATIO !== undefined ? env.CF_PAID_SOFT_STOP_RATIO : env.CF_PAID_CAP_RATIO,
    DEFAULTS.paidSoftCapRatio
  );

  const paidSoftCapPerProcess =
    overrides.paidSoftCapPerProcess !== undefined
      ? overrides.paidSoftCapPerProcess
      : Math.floor((PAID_MONTHLY_LIMIT * paidSoftRatio) / instances);

  const paidCapPerProcess =
    overrides.paidCapPerProcess !== undefined
      ? overrides.paidCapPerProcess
      : Math.floor(readNumber(env.CF_PAID_HARD_LIMIT, DEFAULTS.paidHardLimit) / instances);

  return {
    freePool,
    paidWorker,
    freeCapPerProcess,
    paidSoftCapPerProcess,
    paidCapPerProcess,
    instances,
    dedupeTtlMs: readNumber(env.CF_DEDUPE_TTL_MS, DEFAULTS.dedupeTtlMs),
    dedupeMaxEntries: Math.floor(readNumber(env.CF_DEDUPE_MAX_ENTRIES, DEFAULTS.dedupeMaxEntries)),
    probeThreshold:
      overrides.probeThreshold !== undefined
        ? overrides.probeThreshold
        : readNumber(env.CF_PROBE_THRESHOLD, DEFAULTS.probeThreshold),
    hlschunkFallback: readFlag(env.HLSCUNK_FALLBACK, false),
    logIntervalMs: readNumber(env.WORKER_POOL_LOG_INTERVAL_MS, DEFAULTS.logIntervalMs),
    logEnabled: readFlag(env.WORKER_POOL_LOG, true),
  };
}

/**
 * Build an isolated pool instance. State lives in this closure, so tests get a
 * clean slate per call and the production singleton cannot be polluted.
 */
function createWorkerPool(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const log = typeof options.log === 'function' ? options.log : (line) => console.log(line);
  const httpProbe = typeof options.httpProbe === 'function' ? options.httpProbe : fetch;
  const config = resolveConfig(options.env || process.env, options.overrides || {});

  const freeState = new Map(); // url -> { day, used }
  let paidState = { month: null, used: 0 };
  const dedupe = new Map(); // segment key -> { workerUrl, tier, expiresAt }
  const probeState = new Map(); // url -> { day, probing: boolean, spent: boolean }

  let overflowDay = null;
  let softWarnedMonth = null;
  let logTimer = null;
  let lastExhaustedLogMs = -Infinity;

  function isWorkerSpent(url, day) {
    const s = probeState.get(url);
    return !!(s && s.day === day && s.spent);
  }

  function maybeProbe(url, day) {
    if (config.probeThreshold >= 1) return;
    const used = freeUsedToday(url, day);
    if (used < config.freeCapPerProcess * config.probeThreshold) return;
    const s = probeState.get(url);
    if (s && s.day === day && (s.probing || s.spent)) return;

    probeState.set(url, { day, probing: true, spent: false });
    const probeUrl = url.endsWith('/') ? url : `${url}/`;
    Promise.resolve()
      .then(async () => {
        const res = await httpProbe(probeUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(4000),
        });
        const status = res && res.status;
        const isSpent = status === 403 || status === 429 || status === 503;
        probeState.set(url, { day, probing: false, spent: isSpent });
        if (isSpent && config.logEnabled) {
          log(`[WorkerBudget] ${day}: ${hostOf(url)} probe returned ${status} — marking spent for day`);
        }
      })
      .catch(() => {
        probeState.set(url, { day, probing: false, spent: false });
      });
  }

  function freeUsedToday(url, day) {
    const entry = freeState.get(url);
    return entry && entry.day === day ? entry.used : 0;
  }

  function bumpFree(url, day) {
    const entry = freeState.get(url);
    if (entry && entry.day === day) {
      entry.used += 1;
      return;
    }
    freeState.set(url, { day, used: 1 });
  }

  function paidUsedThisMonth(month) {
    return paidState.month === month ? paidState.used : 0;
  }

  function bumpPaid(month) {
    if (paidState.month !== month) paidState = { month, used: 0 };
    paidState.used += 1;
  }

  function pruneDedupe(atMs) {
    if (dedupe.size <= config.dedupeMaxEntries) return;
    for (const [key, entry] of dedupe) {
      if (entry.expiresAt <= atMs) dedupe.delete(key);
    }
    // Still oversized: drop oldest insertions (Map preserves insertion order).
    while (dedupe.size > config.dedupeMaxEntries) {
      const oldest = dedupe.keys().next();
      if (oldest.done) break;
      dedupe.delete(oldest.value);
    }
  }

  function logSnapshot() {
    if (!config.logEnabled) return;
    const snap = snapshot();
    const free = snap.free.map((w) => `${hostOf(w.url)}=${w.used}/${w.cap}`).join(' ');
    log(
      `[WorkerBudget] ${snap.day} free ${free} paid ${hostOf(snap.paid.url)}=${snap.paid.used}/${snap.paid.softCap}+${snap.paid.hardCap}`
    );
  }

  /**
   * Exhaustion is a per-emission condition, not an event: a six-segment sliding
   * window refetched every two seconds would emit the same line three times a
   * second for as long as the budget stays spent. Collapse it to one line per
   * log interval so a real outage stays visible in the logs.
   */
  function logExhausted(atMs, line) {
    if (!config.logEnabled) return;
    if (atMs - lastExhaustedLogMs < config.logIntervalMs) return;
    lastExhaustedLogMs = atMs;
    log(line);
  }

  function ensureTimer() {
    if (logTimer || !config.logEnabled) return;
    logTimer = setInterval(logSnapshot, config.logIntervalMs);
    if (typeof logTimer.unref === 'function') logTimer.unref();
  }

  /**
   * Choose a worker for one segment emission.
   *
   * `segmentKey` should be the absolute segment URL. Passing the same key again
   * inside the dedupe TTL returns the previous choice without spending any
   * budget, which is what keeps sliding-window re-emissions from inflating the
   * counters. Pass null to spend budget unconditionally.
   *
   * `options.exclude` can be an Array or Set of worker URLs to skip when selecting
   * from available candidates.
   *
   * Returns { url, tier: 'free'|'paid', reused } or null when both tiers are
   * exhausted.
   */
  function pick(segmentKey, options = {}) {
    ensureTimer();

    const at = now();
    const atMs = at.getTime();
    const day = utcDayKey(at);
    const month = utcMonthKey(at);

    if (segmentKey) {
      const cached = dedupe.get(segmentKey);
      if (cached && cached.expiresAt > atMs) {
        return { url: cached.workerUrl, tier: cached.tier, reused: true };
      }
      if (cached) dedupe.delete(segmentKey);
    }

    const exclude = options && options.exclude
      ? (options.exclude instanceof Set ? options.exclude : new Set(options.exclude))
      : null;

    const available = config.freePool.filter(
      (url) =>
        (!exclude || !exclude.has(url)) &&
        !isWorkerSpent(url, day) &&
        freeUsedToday(url, day) < config.freeCapPerProcess
    );

    let chosen;
    if (available.length) {
      const url = available[Math.floor(random() * available.length)] || available[0];
      bumpFree(url, day);
      maybeProbe(url, day);
      chosen = { url, tier: 'free' };
    } else if ((!exclude || !exclude.has(config.paidWorker)) && paidUsedThisMonth(month) < config.paidCapPerProcess) {
      bumpPaid(month);
      const usedNow = paidUsedThisMonth(month);
      if (usedNow >= config.paidSoftCapPerProcess && softWarnedMonth !== month) {
        softWarnedMonth = month;
        if (config.logEnabled) {
          log(
            `[WorkerBudget] ${month}: paid worker usage (${usedNow}) crossed soft cap (${config.paidSoftCapPerProcess}) — billing active above 10M`
          );
        }
      }
      chosen = { url: config.paidWorker, tier: 'paid' };
      if (overflowDay !== day) {
        overflowDay = day;
        if (config.logEnabled) {
          log(`[WorkerBudget] ${day}: every free worker is at cap, overflowing to paid worker`);
        }
      }
    } else {
      logExhausted(
        atMs,
        `[WorkerBudget] ${day}: free and paid budgets both exhausted — no worker available`
      );
      return null;
    }

    if (segmentKey) {
      dedupe.set(segmentKey, {
        workerUrl: chosen.url,
        tier: chosen.tier,
        expiresAt: atMs + config.dedupeTtlMs,
      });
      pruneDedupe(atMs);
    }

    return { ...chosen, reused: false };
  }

  function snapshot() {
    const at = now();
    const day = utcDayKey(at);
    const month = utcMonthKey(at);
    const paidUsed = paidUsedThisMonth(month);
    return {
      day,
      month,
      free: config.freePool.map((url) => ({
        url,
        used: freeUsedToday(url, day),
        cap: config.freeCapPerProcess,
        spent: isWorkerSpent(url, day),
      })),
      paid: {
        url: config.paidWorker,
        used: paidUsed,
        softCap: config.paidSoftCapPerProcess,
        hardCap: config.paidCapPerProcess,
        overSoftCap: paidUsed >= config.paidSoftCapPerProcess,
        cap: config.paidCapPerProcess,
      },
    };
  }

  function stop() {
    if (logTimer) {
      clearInterval(logTimer);
      logTimer = null;
    }
  }

  return { config, pick, snapshot, logSnapshot, stop };
}

module.exports = {
  createWorkerPool,
  resolveConfig,
  DEFAULT_FREE_POOL,
  DEFAULT_PAID_WORKER,
  FREE_DAILY_LIMIT,
  PAID_MONTHLY_LIMIT,
  PAID_HARD_LIMIT,
  utcDayKey,
  utcMonthKey,
};
