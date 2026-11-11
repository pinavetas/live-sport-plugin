# MATCHES_CACHE_PATH — change set and cutover runbook

**Date:** 2026-10-26
**Status:** implemented and verified **locally only**. Nothing on the VPS has been changed: no build, no swap, no reload, no `pm2 save`, no deletions.
**Fixes:** V1 + V8 in `docs/VPS_AUDIT_2026-10-26.md`; V2's remaining action.

---

## 1. The bug in one line

The source resolves the cache relative to `process.cwd()`:

```js
const rootDataDir = path.join(process.cwd(), 'data');
return path.join(rootDataDir, 'matches_cache.json');
```

`ncc` rewrites that at build time. From the bundle built for this change (`dist.next/index.js`):

```js
const e = n.ab + "data";
if (!s.existsSync(n.ab + "data")) { try { s.mkdirSync(n.ab + "data", { recursive: true }); } catch (e) {} }
return n.ab + "matches_cache.json";            // ← "data" segment dropped
```

So a bundle always reads and writes `<bundle dir>/matches_cache.json`, i.e. `dist/matches_cache.json`, no matter what the source says. A rebuild reproduces this byte-for-byte, which is why the env override — read at runtime, after bundling — is the only external control.

## 2. What changed (local working tree, uncommitted)

| File | Change |
| :--- | :--- |
| `src/services/CacheService.js` | `resolveCacheFile()` honours `MATCHES_CACHE_PATH` (via `path.resolve`) **after** the `JEST_WORKER_ID` branch, so test isolation can never be un-isolated by a shell variable. Constructor logs the resolved path once per process (`[CacheService] matches cache: …`), for V8's "log it at boot". |
| `tests/matchCachePathOverride.test.js` | 4 tests: override beats the `cwd/data` default; the value is normalised; jest isolation beats the override; `setMatches` writes to the override path and creates its parent directory. |
| `ecosystem.config.js` | `MATCHES_CACHE_PATH: '/root/nuvio-live-sports/data/matches_cache.json'`; `max_memory_restart` aligned `1300M` → `1500M` (V2). Both documented inline. |

`git diff --stat`: 2 files changed, 31 insertions(+), 1 deletion(-), plus the new test file.

**Verification (local):**

| Check | Result |
| :--- | :--- |
| Bundle contains the override branch, ahead of the rewritten default | confirmed in `dist.next/index.js` |
| Bundle contains the boot log | confirmed |
| Source probe: `MATCHES_CACHE_PATH=C:/tmp/probe/matches.json` | resolves `C:\tmp\probe\matches.json`, logs it |
| Cache-path / file-identity / empty-poll / meta-revision / channel-identity suites | 5 suites, 56 passed, 1 skipped |
| Full suite (`npx jest`, 111 suites) | 1169 passed, 12 failed in 3 suites |
| Those 3 suites in isolation, **with** and **without** the change | identical (39 passed, 1 failed — `ak47LiveProvider` date fixture); the full-run failures are timing tests under parallel load |

The build was made into `dist.next`, never into the live `dist/`.

## 3. Production pre-flight (read-only, verified 2026-10-26)

| Item | Observed |
| :--- | :--- |
| `git HEAD` | `50611f7`, only `.env.bak` / `ecosystem.config.js.bak` untracked |
| Live cache | `dist/matches_cache.json` **14,212,650 B**, 14:20:49 — 16,096 matches |
| Stale copies | `data/` 9,551,740 B (Oct 24), repo root 9,294,528 B (Oct 23), `dist/data/` 9,551,740 B |
| Running env | **no** `MATCHES_CACHE_PATH` anywhere (0 hits in `pm2 jlist`) → the var is new |
| Ceiling | running `1,572,864,000` B (1500M) for both workers; file on disk still `1300M` → confirms V2 |
| Node on the box | **v22.23.2** (the local audit measured on v24.20.0 — treat its absolute ms as indicative) |
| Disk | 42 G free |
| `pm2-logrotate` | 3.0.0 online, 78.3 MB |
| Running `IMPIT_RECYCLE_MS` | **240000** (4 min) — the file's `600000` was never applied, so the file is pinned to 240000: a reload must not widen the impit recycle window as a side effect |
| Build tooling | `ncc` and `copyfiles` are **not** in `node_modules/.bin`; the build depends on `npx` fetching them (registry reachable, PONG 215 ms, `~/.npm/_npx` cache present) |
| Stray resolver (V5) | still running, pid 3876074, port 7013 |
| Warm-path probe | `/manifest.json` 9 ms; `/catalog/tv/nuvio_sports_catalog.json` 51 ms |

The last row is the important caveat: the warm path is fast. The audit's 1.66–1.87 s p95 is the **tail** (cold page builds colliding with sync stalls), so a single GET will never reproduce it — only repeated cold page keys or `monitorEventLoopDelay` will.

## 4. Cutover procedure (NOT executed — needs explicit approval)

Order matters: `data/matches_cache.json` must hold a fresh snapshot **before** the first reload that carries the env var, or the workers come up on a two-day-old catalog (or an empty one).

```bash
cd /root/nuvio-live-sports

# 0. Backstop
tar czf /root/backups/pre-cutover-$(date +%Y%m%d-%H%M%S).tgz \
  dist ecosystem.config.js data/matches_cache.json

# 1. Upload this change set (source + ecosystem), commit or not — build is from src/
#    git pull / scp src/services/CacheService.js, ecosystem.config.js

# 2. Build beside the live tree — never into dist/ (V1b: SIGSEGV on both workers)
npx @vercel/ncc build src/index.js -o dist.next --minify -e sharp
npx -y copyfiles -f "src/providers/*.wasm" "src/providers/*.js" dist.next
npx -y copyfiles -u 2 "resolver/src/**/*" dist.next/src
node -e "require('fs').writeFileSync('dist.next/src/package.json', JSON.stringify({type:'module'},null,2))"
npx -y copyfiles -u 1 "public/**/*" dist.next/public
npx -y copyfiles -f "src/data/*.json" dist.next/data
npx -y copyfiles -f "src/data/*.json" dist.next/src/data

# 3. Verify the artifact before touching anything live
node --check dist.next/index.js
grep -c MATCHES_CACHE_PATH dist.next/index.js        # expect 1

# 4. Atomic swap (a directory mv does not fault the mapped inode of the old dist/)
mv dist dist.prev-$(date +%Y%m%d-%H%M%S)
mv dist.next dist

# 5. Refresh the cache file the new env var points at — from the snapshot that was
#    live seconds ago, so the reload has fresh data to serve
cp -p dist.prev-*/matches_cache.json data/matches_cache.json

# 6. Reload with the new env (rolling; cluster mode)
pm2 reload ecosystem.config.js --update-env
```

**Then, only after verification (§5) and your approval:** `pm2 save`, delete the strays (`matches_cache.json` at repo root, `dist/data/matches_cache.json`, old `data/` copy is now the live one), and `kill 3876074` for V5.

## 5. Verification checklist

```bash
pm2 logs nuvio-sports --lines 60 --nostream | grep 'matches cache:'
#   expect: [CacheService] matches cache: /root/nuvio-live-sports/data/matches_cache.json
pm2 jlist | grep -o '"max_memory_restart":[0-9]*' | sort | uniq -c
#   expect the two workers at 1572864000
ls -l --time-style=+%F_%T data/matches_cache.json
#   expect mtime to advance after the next sync (~10 min) — proof the workers write there
node -e "const j=require('/root/nuvio-live-sports/data/matches_cache.json');console.log(j.matches.length)"
#   expect ~16k
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://127.0.0.1:7000/manifest.json
pm2 describe nuvio-sports | sed -n '/Code metrics/,$p'   # p95 before/after
```

Watch for: `restart_time` climbing (crash loop), heap near 1.5 GB, and `dist/matches_cache.json` being **re-created** — if it reappears and grows, the env var did not reach the workers (`--update-env` missing).

## 6. Rollback

```bash
cd /root/nuvio-live-sports
mv dist dist.broken-$(date +%Y%m%d-%H%M%S)
mv dist.prev-* dist
pm2 reload ecosystem.config.js --update-env
```

Data is safe in both directions: `data/matches_cache.json` is a copy, and the pre-cutover tarball holds the original `dist` + cache.

## 7. Known risks

1. **Stale `data/` on first reload.** Mitigated by step 5. Do not reorder steps 5 and 6.
2. **In-place build kills both workers** (V1b). Steps 2–4 exist to avoid it; a `npm run build` at any point re-creates the hazard.
3. **Node 22 vs 24.** Local benchmarks were taken on v24.20.0; the box runs v22.23.2. Re-benchmark on the box before quoting §1.2 numbers as production truths.
4. **The bundle embeds a cache copy.** `ncc` traces `data/matches_cache.json` and emits it at `dist.next/matches_cache.json` (~14 MB). Harmless once the env var is set, and useful as a fallback if it was fresh at build time — but it means `dist/` always contains a cache file, which is what makes this bug so easy to misread.
5. **`max_memory_restart` is in the same file.** Any reload from the ecosystem file now also applies the 1500M ceiling — intended, but it means the two changes ship together.
6. **The reload applies the whole env block, not just one variable.** `IMPIT_RECYCLE_MS` had drifted (240000 running vs 600000 in the file) and is pinned to 240000 for exactly this reason; leaving it at 600000 would have widened the impit recycle window on the same reload and raised per-worker RSS as an unannounced side effect.
