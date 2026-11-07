const cron = require('node-cron');
const StreamResolveCache = require('../services/StreamResolveCache');

// Catalog stale-while-revalidate window: once the cache is older than this,
// the next catalog/meta request triggers a background re-sync (see ensureFresh).
const REVALIDATE_AFTER_MS = parseInt(process.env.CATALOG_REVALIDATE_MS, 10) || 10 * 60 * 1000;
// A sync that has been "in progress" longer than this is presumed stuck (a
// provider promise that never settled); the next trigger may start a new one
// instead of being skipped forever.
const SYNC_WATCHDOG_MS = parseInt(process.env.SYNC_WATCHDOG_MS, 10) || 5 * 60 * 1000;

// node-cron fires on schedule regardless of whether the previous run of the
// same job finished. A prewarm tick (every 3 min, sequential mints) or a
// custom-AI sweep can outlast its interval under load, and overlapping runs
// pile up upstream requests and race on shared state. noOverlap (node-cron
// >= 4) skips a tick while that job's previous execution is still pending.
const JOB_OPTIONS = (name) => ({ name, noOverlap: true });

class CronService {
  constructor({ matchAggregator, streamResolveCache, cacheService, providerHealthService }) {
    this.matchAggregator = matchAggregator;
    this.streamResolveCache = streamResolveCache;
    this.cacheService = cacheService;
    this.providerHealthService = providerHealthService;
    this.syncing = false;
    this.syncStartedAt = 0;
    this.syncGeneration = 0;
    this.syncWatchdogMs = SYNC_WATCHDOG_MS;
  }

  get isSyncing() { return this.syncing; }
  set isSyncing(v) { this.syncing = v; }

  // True while a sync is genuinely running. A sync older than the watchdog is
  // treated as abandoned so it cannot block every later sync. (syncStartedAt
  // is 0 when `syncing` was set externally, which is respected as-is.)
  _syncInProgress() {
    if (!this.syncing) return false;
    if (this.syncStartedAt && Date.now() - this.syncStartedAt > this.syncWatchdogMs) {
      console.warn(`[CronService] Sync running for ${Math.round((Date.now() - this.syncStartedAt) / 1000)}s exceeded the ${Math.round(this.syncWatchdogMs / 1000)}s watchdog; resetting the syncing flag.`);
      this.syncing = false;
      this.syncStartedAt = 0;
      return false;
    }
    return true;
  }

  async runSync() {
    if (this._syncInProgress()) return;
    // The generation token keeps an abandoned sync that finally settles from
    // clearing the flag of the sync that replaced it.
    const generation = ++this.syncGeneration;
    this.syncing = true;
    this.syncStartedAt = Date.now();
    try {
      const activeMatches = await this.matchAggregator.syncMatches();
      if (activeMatches !== null) {
        this.pruneStreamCache(activeMatches);
        this.prewarmCatalogMemo();
      }
    } catch (error) {
      if (this.providerHealthService) {
        this.providerHealthService.finishSync({ matchCount: 0, succeeded: false });
      }
      throw error;
    } finally {
      if (this.syncGeneration === generation) {
        this.syncing = false;
        this.syncStartedAt = 0;
      }
    }
  }

  // Rebuild the hot catalog pages right after a sync, so no user ever pays the
  // post-sync rebuild. Every sync bumps CacheService.rev and wipes the page
  // memo; the first catalog request after that rebuilt from scratch (2-8s
  // baseline, 10-24s measured when it collided with peak-hour work). Building
  // the two hottest pages here — in a controlled background moment seconds
  // after the sync — means arriving users hit a warm memo (~11ms) instead of
  // becoming the rebuild trigger. Fire-and-forget with error swallowing: if
  // this fails, behavior is exactly the old first-request-rebuilds path.
  prewarmCatalogMemo() {
    if (String(process.env.CATALOG_MEMO_PREWARM ?? 'true') === 'false') return;
    if (this._memoPrewarmBusy) return;
    this._memoPrewarmBusy = true;
    setImmediate(async () => {
      try {
        const { handleCatalog } = require('../catalog');
        // Yield between pages so this never blocks request handling.
        await handleCatalog('tv', 'nuvio_sports_live', {}, {}).catch(() => {});
        await new Promise((r) => setImmediate(r));
        await handleCatalog('tv', 'nuvio_sports_catalog', {}, {}).catch(() => {});
      } catch (_) {
        // Never let memo hygiene disturb the sync cycle.
      } finally {
        this._memoPrewarmBusy = false;
      }
    });
  }

  // Catalog stale-while-revalidate: serve the cached list immediately and
  // refresh in the background once the cache passes REVALIDATE_AFTER_MS.
  // Traffic-driven, so idle instances stay quiet; the 4-hour cron is the floor.
  ensureFresh() {
    try {
      const isPrimary = (process.env.NODE_APP_INSTANCE === undefined || process.env.NODE_APP_INSTANCE === '0') &&
                        (process.env.pm_id === undefined || process.env.pm_id === '0');
      if (!isPrimary) return;
      if (this._syncInProgress()) return;
      if (!this.cacheService || !this.cacheService.isStale(REVALIDATE_AFTER_MS)) return;
      console.log('[CronService] Catalog stale, triggering background re-sync (SWR)...');
      this.runSync().catch((err) => console.error('[CronService] SWR sync failed:', err.message));
    } catch (err) {
      console.error('[CronService] ensureFresh error:', err.message);
    }
  }

  start() {
    console.log('[CronService] Starting background jobs...');
    
    // Fetch and cache matches every 4 hours
    cron.schedule('0 */4 * * *', async () => {
      console.log('[CronService] Running match sync job...');
      try {
        await this.runSync();
      } catch (err) {
        console.error('[CronService] Match sync failed:', err.message);
      }
    }, JOB_OPTIONS('match-sync'));

    // Background sync for dynamic Custom AI parsers (every 30 mins)
    cron.schedule(process.env.CUSTOM_AI_CRON_SCHEDULE || '*/30 * * * *', async () => {
      try {
        const container = require('../container');
        const dynamicParserRegistry = container.resolve('dynamicParserRegistry');
        const active = dynamicParserRegistry ? dynamicParserRegistry.activeProviders : null;
        if (active && active.size > 0) {
          console.log(`[CronService] Running background sync for ${active.size} custom AI parser(s)...`);
          const cache = container.resolve('cacheService');
          for (const provider of active.values()) {
            try {
              const matches = await provider.getMatches();
              if (matches && matches.length > 0 && cache) {
                const existing = (cache.getMatchesReadOnly ? cache.getMatchesReadOnly() : cache.getMatches()) || [];
                const matchIds = new Set(matches.map(m => m.id));
                const filtered = existing.filter(m => !matchIds.has(m.id));
                cache.setMatches([...filtered, ...matches]);
              }
            } catch (pErr) {
              console.warn(`[CronService] Custom AI sync error for ${provider.name}: ${pErr.message}`);
            }
          }
        }
      } catch (err) {
        console.error('[CronService] Custom AI sync job failed:', err.message);
      }
    }, JOB_OPTIONS('custom-ai-sync'));

    // Prewarm LIVE matches only, so a click is near-instant.
    //
    // Deliberately narrow to protect the upstreams (this was previously disabled
    // for exactly that reason):
    //   - only matches that are genuinely LIVE right now (isMatchLive), which
    //     excludes replays, upcoming fixtures and 24/7 network channels;
    //   - capped at PREWARM_MAX matches per tick;
    //   - this tick also skips any match whose sources are already cached, so a
    //     warm instance does no work at all.
    cron.schedule(process.env.PREWARM_CRON_SCHEDULE || '*/3 * * * *', async () => {
      try {
        await this.prewarmPopular();
      } catch (err) {
        console.error('[CronService] Prewarm job failed:', err.message);
      }
    }, JOB_OPTIONS('prewarm'));

    // Run first sync in background on boot so the catalog and all providers (including replays) are fresh immediately
    setImmediate(async () => {
      try {
        console.log('[CronService] Initiating startup match sync...');
        await this.runSync();
      } catch (err) {
        console.error('[CronService] Startup match sync failed:', err.message);
      }
    });

    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    if (externalUrl) {
      console.log(`[CronService] Keep-alive enabled for ${externalUrl}`);
      cron.schedule('*/14 * * * *', async () => {
        try {
          console.log(`[CronService] Pinging external URL to prevent sleep...`);
          const { request } = require('undici');
          await request(`${externalUrl}/health`);
        } catch (err) {
          console.error('[CronService] Keep-alive ping failed:', err.message);
        }
      }, JOB_OPTIONS('keep-alive'));
    }

    // Run first sync immediately on boot
    setTimeout(async () => {
      try {
        console.log('[CronService] Running initial match sync...');
        await this.runSync();
      } catch(e) {
        console.error('[CronService] Match sync failed:', e.message);
      }
    }, 1000);
  }

  /** Drop stream-cache entries for matches that are no longer active. */
  pruneStreamCache(activeMatches) {
    try {
      if (!this.streamResolveCache) return;
      const ids = new Set((activeMatches || []).map(m => m && m.id).filter(Boolean));
      this.streamResolveCache.pruneEnded(ids);
    } catch (_) {}
  }

  /**
   * Prewarm LIVE matches so hot streams are already resolving when clicked.
   *
   * Scope is deliberately narrow:
   *   - LIVE only (isMatchLive) - no replays, no upcoming, no 24/7 networks;
   *   - hard cap per tick;
   *   - sources already in the resolve cache are skipped, so a warm instance
   *     performs no upstream requests at all.
   */
  async prewarmPopular() {
    try {
      const PREWARM_MAX = Number(process.env.PREWARM_MAX_MATCHES || 12);
      if (PREWARM_MAX <= 0) return; // master switch: 0 disables every prewarm path
      const { isMatchLive, isReplayMatch } = require('../catalog');
      const { prewarmMatch, prewarmSkipProvidersSet } = require('../streams');
      const resolveCache = this.streamResolveCache;
      const skip = prewarmSkipProvidersSet();
      // Filtering/sorting below only reads, so the defensive deep clone of
      // getMatches() is pure GC churn on this 3-minute tick. Use the internal
      // read-only array and slice() so the in-place sort reorders our copy,
      // not the master catalog. Only the matches actually prewarmed get
      // cloned (in the loop below) since resolve paths may mutate them.
      const roMatches = this.cacheService
        ? (this.cacheService.getMatchesReadOnly ? this.cacheService.getMatchesReadOnly() : this.cacheService.getMatches())
        : [];
      const matches = Array.isArray(roMatches) ? roMatches.slice() : roMatches;

      const live = matches.filter((m) => {
        if (!m || !m.sources || m.sources.length === 0) return false;
        if (m.category === 'networks') return false;      // 24/7 channels
        if (m.category === 'other') return false;         // other sports
        if (isReplayMatch(m)) return false;                // replays
        // Matches whose sources are ALL heavy embed-family providers never
        // prewarm (see PREWARM_SKIP_PROVIDERS) — excluding them here keeps the
        // tick log honest instead of announcing no-op mints.
        if (!m.sources.some((s) => s && !skip.has(String(s.source || '').toLowerCase()))) return false;
        return isMatchLive(m);                             // genuinely live
      });
      if (live.length === 0) return;

      // Only among LIVE matches: prefer popular, then most viewers/recent kickoff.
      live.sort((a, b) => {
        const ap = a.popular === '1' ? 1 : 0;
        const bp = b.popular === '1' ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (Number(b.date) || 0) - (Number(a.date) || 0);
      });

      // Skip matches whose sources are already cached (nothing to do).
      const todo = [];
      for (const m of live) {
        if (todo.length >= PREWARM_MAX) break;
        let warm = false;
        if (resolveCache) {
          const prioritySources = m.sources.filter(s => ['daddylive', 'ppvst'].includes(s.source) && !skip.has(String(s.source || '').toLowerCase()));
          if (prioritySources.length > 0) {
            warm = prioritySources.every(s => resolveCache.isResolved(StreamResolveCache.resolveKey(s, m.id)));
          } else {
            warm = m.sources.some((s) => !skip.has(String(s.source || '').toLowerCase()) && resolveCache.isResolved(StreamResolveCache.resolveKey(s, m.id)));
          }
        }
        if (!warm) todo.push(m);
      }
      if (todo.length === 0) return;

      console.log(`[CronService] Prewarming ${todo.length} live match(es) (of ${live.length} live)`);
      // Sequential: never bursts upstream. Low priority, so slow is fine.
      // (Heavy embed-family sources are excluded upstream via
      // PREWARM_SKIP_PROVIDERS in prewarmMatch — see streams.js.)
      for (const m of todo) {
        // Deep-clone only the handful of selected matches (plain JSON shapes;
        // see CacheService._cloneMatch) — resolve paths may mutate sources.
        const clone = JSON.parse(JSON.stringify(m));
        await prewarmMatch(clone, null, Number.MAX_SAFE_INTEGER).catch(() => {});
      }
    } catch (err) {
      console.error('[CronService] Prewarm failed:', err.message);
    }
  }

}

module.exports = CronService;
