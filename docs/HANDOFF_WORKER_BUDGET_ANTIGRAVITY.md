# Antigravity handoff — Cloudflare worker budget (1 paid + 6 free)

Paste everything below the rule into Antigravity. It is self-contained: the agent does not need the earlier conversation.

---

## Task

Finish and harden the Cloudflare worker budget allocator in this repo, so that one paid worker (10M requests/month included, billed above that) and six free workers (100k requests/day each, hard stop) are spent as efficiently as possible.

Repo root: `C:\Users\odeda\Desktop\Projects\Nuvio Live Sports Plugin`
Stack: Node 24, CommonJS, Jest, PM2 cluster mode, no TypeScript.

## Already done — do not rebuild

Two commits are on `main` (local, unpushed): `f646403` feat(workers) budget allocator, `87a0e72` fix(worker) cloak-prefix stripping.

- `src/services/WorkerBudget.js` — `createWorkerPool()`: random pick within the six free workers, skipping any at 90% of its 100k/day cap; overflow to the paid worker at 95% of the 10M/month allowance; then return `null`. Segment emissions are deduped per URL for 120s. Per-worker caps are divided by `WORKER_INSTANCE_COUNT` (2, matching `instances: 2` in `ecosystem.config.js`).
- `src/services/HlsRewriteService.js` — `.image` segments go through `workerPool.pick(absoluteUrl)`; on `null` it emits `/api/hlschunk` unless `HLSCUNK_FALLBACK=off`, in which case it emits the upstream URL. `CF_IMAGE_WORKER_POOL` is the free tier only.
- `tests/hlsRewriteService.test.js` — 20 offline tests, green. Full suite: 85 suites, 1012 passed, 1 skipped.
- `.env.example`, `docs/BANDWIDTH_AND_CACHING.md`, `ecosystem.config.js` updated.

If `git log --oneline -2` does not show both commits, stop and report instead of re-implementing them.

## Hard constraints

- Never commit `.env`; never edit `dist/`; never `git push`.
- No video bytes through the VPS: do not add or widen `/api/hlschunk`, `/api/mp4proxy`, `/api/fastmp4` (GEMINI.md, "Zero Server Bandwidth Bleed Policy").
- Keep the whole suite green. Commit each task separately, in the GEMINI.md format (`Summary:` with Problem / Solution).
- Each task must be independently committable. The previous session was cut off mid-plan: stop at the end of a task and report, rather than starting the next one.
- Files are CRLF on disk; do not reflow whole files over whitespace.

## Tasks, in order

1. **Audit only, no edits.** Confirm both commits, run `npx jest tests/hlsRewriteService.test.js`, and list every code path that reaches a worker without passing through `workerPool` (start at `src/providers/CdnLiveProvider.js` around line 297). Report a numbered gap list, then stop.

2. **Count the edge-scrape calls.** `CdnLiveProvider` shuffles `CF_IMAGE_WORKER_POOL` and tries up to 3 workers on a 403/429. Those requests consume the same 100k/day quota but are invisible to the budget. Route them through `workerPool.pick(key)`, never let a speculative retry reach the paid worker, and add a test.

3. **Detect a worker that is already out of quota.** The allocator counts emissions, not responses, so a worker that Cloudflare has already blocked keeps receiving traffic until the local counter drains. Implement the cheapest reliable signal available (periodic probe, or a response hook if one exists in the codebase) that marks that worker spent for the UTC day, and document the chosen trade-off in `WorkerBudget.js`.

4. **Observability.** Add a read-only `/api/worker-budget` endpoint returning `pool.snapshot()` (`day`, `month`, per-worker `used`/`cap`, paid tier). No secrets, no mutation. Register it where the other routes are wired.

5. **Reconcile the estimate with reality.** Emission counting can only run ahead of real usage; with a paid tier that means paying early. Compare one UTC day of `snapshot()` against the per-worker request counts in the Cloudflare dashboard, then tune `CF_FREE_CAP_RATIO` (and the dedupe TTL if warranted) and record the measured numbers in `docs/BANDWIDTH_AND_CACHING.md`.

6. **Production default for exhaustion.** `HLSCUNK_FALLBACK` currently defaults to `on`, which puts segment bytes back on the VPS — the exact thing GEMINI.md forbids. Decide the production value, make the default consistent across code, `.env.example` and docs, and pin it with a test.

7. **Close out.** Full `npx jest`; `npm run build` if `@vercel/ncc` is available; update docs; commit. Report what changed and what you deliberately left alone.

## Budget math to keep in mind

6 free x 100k/day = 600k/day (18M/month), plus 10M/month paid, is roughly 933k/day sustained. Free quota resets daily and unused free quota is lost, so the free tier should absorb the daily peak and the paid worker should smooth only the overflow.
