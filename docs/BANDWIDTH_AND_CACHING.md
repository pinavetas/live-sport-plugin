# Bandwidth & Caching

Reference for where this addon's egress actually goes, why, and which fixes were
applied. Read this before touching anything under `public/posters/`, the
`/posters` static mounts, or the `/img*` routes.

Last updated: **2026-09-23** (diagnosed against the production host
`nuviosports.xyz`, 68 GB consumed).

## TL;DR

Video does **not** flow through the VPS. Bandwidth is artwork, and the reason it
was expensive is that nothing was allowed to cache it at either layer.

## The two mechanisms

Cloudflare's default cache policy is **extension-based**: it caches responses
whose URL ends in a known static suffix (`.jpg`, `.png`, `.css`, ...) provided the
response permits it, and treats everything else as dynamic. Almost every
symptom follows from that one rule.

| Endpoint | Extension? | Cache-Control sent | Cloudflare | Why |
|---|---|---|---|---|
| `/posters/replays/luffy_*.jpg` | yes | `no-cache, no-store, must-revalidate` | `BYPASS` | extension eligible, header forbade it |
| `/img/collection/:sport` | **none** | `max-age=86400` | `DYNAMIC` | extensionless, never eligible by default |
| `/img/match` | **none** | `max-age=120, s-maxage=300` | `DYNAMIC` | extensionless |
| `/img?url=...` | **none** | `max-age=120, s-maxage=300` | `DYNAMIC` | extensionless |
| `/img/sport/:sport`, `/img/date` | **none** | `max-age=86400` | `DYNAMIC` | extensionless |
| `/logo.png`, `/bitcoin.png`, `/solana.png` | yes | `max-age=14400` | `REVALIDATED` / `EXPIRED` / `MISS` | control set: extension + permissive header = cached |

Measured payload sizes: replay hero JPEGs 167–289 KB; `/img/match` ~83.5 KB avg
(100 per replay catalogue page); `/img?url=` ~35.8 KB avg (100 per sport
catalogue page); `/img/collection` 277 KB. `/api/manifest` is ~2 KB and is the
only endpoint a player polls repeatedly — it is not the problem.

**Consequence:** no header change can ever make `/img*` cacheable, because it has
no extension. That requires an explicit Cloudflare Cache Rule (below).
`/posters` needs no rule — the extension already qualifies.

## Video is not the cause

Sampling 219 segment URIs emitted by live manifests across football, MMA,
basketball, motorsport, cricket and networks catalogues:

| Destination | Lines |
|---|---|
| Cloudflare Worker pool (`*.workers.dev`) | 210 |
| Direct upstream CDN | 9 |
| **VPS** | **0** |

Latent risk, now bounded: `src/services/HlsRewriteService.js` used to fall back
to the VPS `/api/hlschunk` proxy for `.image` segments whenever
`getCfImageWorker()` returned null, and the pool held seven interchangeable free
workers that all exhausted at the same moment.

The pool is now budgeted (`src/services/WorkerBudget.js`): six free workers
(100k/day each, hard stop) are spent first, and the single paid worker on
`nuvio-proxy2` (10M/month included, soft warning at 95%, hard ceiling at 20M/month)
takes the overflow. The paid worker is filtered out of the free pool entirely, so it is
unreachable by the random draw. Exhaustion occurs only when the free tier is spent AND
the paid tier exceeds the hard ceiling. On exhaustion, `HLSCUNK_FALLBACK` defaults to `off`
(production default), emitting the upstream CDN URL directly so video bytes never pass
through the VPS (enforcing the Zero Server Bandwidth Bleed Policy). `HLSCUNK_FALLBACK=on`
is available only as a temporary emergency escape hatch.

## The hub multiplier

`/collections.json` (15.9 KB) declares `pinToTop: true`, so every user loads it
first. Each of its 8 folders names the *same* JPEG in four fields —
`coverImageUrl`, `focusGifUrl`, `heroBackdropUrl`, `backdropUrl` — i.e. 32
references resolving to 8 unique files. That was 1.81 MB uncacheable per load;
now 0.86 MB after the re-encode.

## Changes applied (2026-09-23)

### 1. `/posters` made cacheable — `src/index.js`

`posterStaticOptions` previously forced `no-store`. It now sends a long-lived
public policy:

```js
const posterStaticOptions = {
  maxAge: '30d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
  }
};
```

`Pragma: no-cache` and `Expires: 0` were removed. The three
`app.use('/posters', express.static(...))` mounts are unchanged.

**Deployed and verified 2026-09-23.** After the push, the live host returns
`Content-Length: 96354` (the recompressed file), the new `Cache-Control`, and
`cf-cache-status: HIT` with an `Age` header on repeat requests. The earlier
`MISS` responses were a cold edge cache, not a configuration failure. No
Cloudflare rule was needed for this endpoint.

> The one remaining `no-store` in `src/index.js` belongs to the dynamic
> `/collections.json` endpoint and is correct there. Do not "fix" it.

### 2. Replay artwork re-encoded

`public/posters/replays/luffy_*.jpg` re-encoded in place at quality 85 (mozjpeg,
4:2:0, progressive), dimensions unchanged at 1024×576. **1851 KB → 862 KB
(−53%).** Same bytes also propagated to `dist/posters/replays/`,
`dist/public/posters/replays/` and `dist/collections/`.

Originals preserved at `scratch/posters-backup-2026-09-23T15-52-22-686Z/`

Durable across deploys: `npm run build` only copies `public/**/*` into
`dist/public/` (via `copyfiles`). Nothing re-encodes, regenerates, or writes into
`public/posters/`, and no npm script post-processes these images, so the
recompressed bytes survive a redeploy unchanged.

(git-ignored, 1851 KB).

## Cloudflare Cache Rule for `/img`

`/img*` cannot be fixed by code. One Cache Rule was required; it was
**deployed and verified on 2026-09-24**. The settings are kept here so the rule
can be recreated if the zone is ever rebuilt:

- **If** `URI Path` **starts with** `/img`
- **Then** Cache eligibility: **Eligible for cache**
- **Edge TTL:** `Use cache-control header if present, use default Cloudflare caching behavior if not`
- Leave Cache Key, Browser TTL and Vary at defaults.

Use `/img`, not `/img/` — the bare `?url=...` endpoint's path is exactly `/img`
and `/img/` would miss one of the largest consumers.

**Do NOT enable "Ignore query string"** for `/img`. The `?url=<upstream>` value
*is* the image identity; ignoring it would serve one team's crest for another.

Purge the zone cache after deploying so old `BYPASS`/`no-store` responses clear.

The template named **"Cache default file extensions"** in the Cache Rules UI
describes the default precisely: *"making only default extensions eligible for
cache"*. That is the whole reason `/img*` needs an explicit rule while
`/posters/*.jpg` does not. Before the rule existed, `/img/collection`, `/img/match`, `/img/sport` and
`/img?url=` all reported `DYNAMIC` **even though their `Cache-Control` headers
were already correct** — no code or header change can fix an extensionless path.
After deployment all four report `MISS` on a cold edge and `HIT` with an `Age`
header thereafter. If any of them ever regresses to `DYNAMIC`, this rule has been
lost or placed on the wrong zone — check the rule before touching any code.

## Do NOT do these

- **Do not create `public/posters/collections/`.** `tests/posterIntegrity.test.js`
  explicitly asserts that folder does not exist and that `public/posters` holds
  exactly eight `luffy_*` files. Adding it fails the suite.
- **Do not rename the posters to `.webp`/`.avif` without a full migration.**
  AVIF measures −78% and is tempting, but: every reference in `src/catalog.js`
  and `src/collections.js` is pinned to `.jpg`, eight assertions in
  `tests/posterIntegrity.test.js` match `.jpg`, and the `.jpg` extension is
  precisely what makes change 1 work. Switch only if you also rewrite those
  references and accept an explicit Cache Rule for the new extension.
- **Do not edit only on the server.** The deploy workflow runs
  `git reset --hard HEAD` and rebuilds, so uncommitted server-side edits are
  discarded on the next push.
- **Do not edit `dist/`.** It is git-ignored build output.
- Note: `dist/collections/*.jpg` (served by `/img/collection/:sport`) has **no
  source in `public/`** and is **not** regenerated by `npm run build`. The route
  checks `public/posters/collections/` first, so production is serving a stale
  on-disk copy from before the poster deduplication. Nothing in `src/` emits that
  URL — the route is legacy.

## Verification

```bash
# header + size on any poster (expect the large max-age; repeat call -> HIT + Age)
curl -sI https://nuviosports.xyz/posters/replays/luffy_football.jpg | grep -i -E 'cache-control|cf-cache-status'

# /img only reaches HIT once the Cache Rule above is deployed
curl -s -o /dev/null -D - https://nuviosports.xyz/img/collection/football | grep -i cf-cache-status

# the suites that actually read these image bytes
npx jest tests/imageDimensions.test.js tests/posterIntegrity.test.js
```

## Rollback

```bash
git checkout -- src/index.js public/posters/replays
# originals also at scratch/posters-backup-2026-09-23T15-52-22-686Z/
```

## Outstanding — NOT fixed

Verified on 2026-09-23, still open. These allow anonymous third parties to relay
arbitrary URLs through the host:

- `/api/hlschunk`, `/api/mp4proxy`, `/api/fastmp4` and `/img` all returned `206`/`200`
  for an unrelated third-party file. `STREAM_PROXY_ALLOWED_HOSTS` is **unset**,
  and in `src/services/OutboundUrlGuard.js` unset means *no hostname restriction*.
- `/api/fastmp4` and `/api/mp4proxy` have **no emitter anywhere in `src/`** (only
  an old test fixture). They are dead by default but still compiled into
  `dist/index.js` and publicly reachable. `ReplayZoneProvider` also appends an
  unused `&proxyChunks=1`.
- No rate limiting exists on `/img` or `/api/*`.
- `src/services/ImageService.js` uses `CACHE_MAX_ENTRIES = 120` against
  catalogues referencing hundreds of distinct images, so the in-memory LRU is
  evicted long before reuse.

## Evidence status

Everything above was measured against the live host by HTTP probing plus source
inspection; no VPS access logs were available. Payload sizes, status codes and
cache headers are **observed**. The attribution of the 68 GB to the image
pipeline is **inferred** from those measurements and was not reconciled against
`vnstat` or an access-log breakdown.

## Worker Budget Calibration

The allocator tracks segment rewrite emissions, which can run ahead of actual requests fetched by the player. Periodic calibration ensures local instance budgets accurately mirror Cloudflare's upstream counters without starving workers or prematurely leaking into the paid tier.

### 1. Retrieve Upstream Worker Counts
In the Cloudflare dashboard:
- Navigate to: **Workers & Pages** → select **your worker** → **Metrics** → **Requests**.
- Filter the time range to a single complete **UTC day** (matching the midnight-to-midnight UTC reset cycle).
- Note the total requests handled by that specific worker.

### 2. Read Addon Snapshot
Fetch the process snapshot from the running instance:
```bash
curl -s http://127.0.0.1:7000/api/worker-budget | jq
# If protected by token:
# curl -s "http://127.0.0.1:7000/api/worker-budget?token=$WORKER_BUDGET_TOKEN" | jq
```

### 3. Compute Real-to-Emission Ratio
Multiply the local worker used count by the cluster instance multiplier (`WORKER_INSTANCE_COUNT`, typically 2 in PM2 cluster mode) to determine the cluster-wide emission total:
```text
Cluster Total = snapshot.used * WORKER_INSTANCE_COUNT
Ratio = Cloudflare Requests / Cluster Total
```

- **Ratio < 0.85:** Emissions significantly outpace playback requests (e.g. users closing streams quickly). The dedupe window (`CF_DEDUPE_TTL_MS`) may be increased, or `CF_FREE_CAP_RATIO` relaxed.
- **Ratio > 1.05:** Cloudflare received more traffic than recorded (e.g. edge-scrapes or direct hits). Tighten `CF_FREE_CAP_RATIO`.

### 4. Configuration Knobs
- `CF_FREE_CAP_RATIO` (default `0.9`): Fractional daily cap (e.g. 90k of 100k) per free worker.
- `CF_PAID_SOFT_STOP_RATIO` (default `0.95`, alias `CF_PAID_CAP_RATIO`): Ratio of 10M included requests at which a warning is emitted.
- `CF_PAID_HARD_LIMIT` (default `20000000`): Absolute monthly request cap before halting paid tier allocation.
- `CF_PROBE_THRESHOLD` (default `0.8`): Threshold fraction of daily cap at which a background HEAD probe verifies worker availability. `>=1.0` disables probing.

### 5. Calibration Log

| Date | Worker | CF dashboard (req) | snapshot() used | Ratio | Action taken |
|---|---|---|---|---|---|
| 2026-10-23 | baseline | not yet measured | — | — | baseline — not yet measured |

## Session Changes (2026-10-23)

Hardened Cloudflare worker pool budget allocation and exhaustion protections:
1. **Edge-scrape retry routing**: `CdnLiveProvider` 429/403 fallback routed through `workerPool.pick(null, { exclude: tried })` (up to 3 distinct free workers); paid worker strictly excluded from edge scraping.
2. **Paid tier soft warning + hard ceiling**: Replaced rigid 95% paid cut with a soft warning threshold (`CF_PAID_SOFT_STOP_RATIO=0.95`, keeping `CF_PAID_CAP_RATIO` alias) and an absolute ceiling (`CF_PAID_HARD_LIMIT=20000000`), ensuring playback resilience without unbounded overage risk.
3. **Zero server bandwidth enforcement**: Flipped `HLSCUNK_FALLBACK` default to `off` across code, docs, and `.env.example`, ensuring exhaustion emits direct CDN URLs and never relays video bytes through the VPS.
4. **Spent worker active probing**: Added detached background `HEAD <worker>/` probing triggered at `CF_PROBE_THRESHOLD` (0.8 of daily cap). HTTP 403, 429, or 503 response marks that worker spent for the UTC day and immediately filters it out of `pick()`.
5. **Observability endpoint**: Exposed `GET /api/worker-budget` mounted ahead of `/api` proxy middleware, returning process snapshot with optional `WORKER_BUDGET_TOKEN` gating.
6. **Dead code removal**: Purged unused `getCfImageWorker()` and `CF_IMAGE_WORKER_POOL` export from `HlsRewriteService.js`.
