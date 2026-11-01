# Project Guidelines & Agent Instructions

## Git Commit & GitHub Push Standards

Whenever staging, committing, or pushing changes to Git/GitHub in this workspace, follow these standards:

### 1. Mandatory Problem-Solution Commit Message
Never create vague, one-line commit messages (e.g., "fix bug", "update code").
Every commit message must be structured, descriptive, and follow the Conventional Commits format (`feat(...)`, `fix(...)`, `perf(...)`, `refactor(...)`).

Every commit message **MUST** explicitly summarize:
- **Problem:** The specific issue, bug, limitation, or requirement being addressed.
- **Solution:** How the implementation resolves the problem.

### 2. "Before & After" Section (When Applicable)
Include an explicit **Before & After** breakdown **only when necessary** (e.g., performance optimizations, algorithmic overhauls, heavy refactoring, or benchmark-driven changes):
- **Before:** Previous state, complexity, or bottleneck.
- **After:** New state, improved complexity, or architectural design.
- **Measured Impact:** Concrete benchmark/test metrics (latency, memory, throughput, pass counts).

### Example Formats:

#### Standard Commit (Feature / Fix):
```text
fix(stream): prevent websocket reconnect storm on network timeout

Summary:
- Problem: Dropped network connections triggered immediate unthrottled reconnect attempts, overwhelming the stream server and exhausting client sockets.
- Solution: Implemented exponential backoff with jitter (500ms initial delay, 2x multiplier, capped at 10s) and a maximum retry threshold.

Verification:
- Added reconnection simulation unit tests (tests/streamReconnect.test.js)
- All 14 tests green
```

#### Performance / Optimization Commit (With Before & After):
```text
perf(catalog): implement Schwartzian transform and O(1) cache indexing

Summary:
- Problem: Large catalogs (3,000+ items) suffered multi-second UI lag during sorting and provider lookups due to redundant regex evaluations and linear scans.
- Solution: Precomputed sort keys via Schwartzian transform and indexed provider lookups in O(1) hash maps.

Before & After:
• Catalog Sorting:
  - Before: O(N log N * K_regex) evaluates 80+ regexes (690 ms on 3,000 items)
  - After:  O(N * K + N log N) Schwartzian transform (75 ms on 3,000 items)
  - Impact: 89.1% faster CPU response

• Stream Match Resolution:
  - Before: Up to 4 consecutive linear scans through all matches (2,798 ms per 3,000 lookups)
  - After:  O(1) Hash Map index lookups (_byId, _byAlias, _bySourceId) (152 ms per 3,000 lookups)
  - Impact: 18.4x faster lookup throughput

Verification:
- Tested under 10,000 concurrent user mutations (tests/concurrencyStressAndIsolation.test.js)
- 40 test suites, 592 tests passing (100% green)
```

---

## Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.


---

## Provider Architecture & Stream Implementation Standards

Whenever implementing, refactoring, or integrating a new streaming provider or resolver, the following rules are strictly enforced:

### 1. Apply DSA Where Necessary (Algorithmic Rigor)
Never write naive, brute-force algorithms on match or channel collections:
- **$O(1)$ Hash Indexing:** Always index incoming provider channels and fixtures into `Map` or `Set` structures by normalized IDs, aliases, and source IDs. Never perform $O(N)$ linear scans or repeated `.find()` loops per request.
- **Aggregator Integration:** New providers must integrate with `MatchAggregator`'s category bucketing and inverted token index (`tokenIndex`). Never introduce unbucketed $O(N^2)$ cross-provider pairwise comparisons.
- **Precomputed Normalization (Schwartzian Principle):** Precompute text folding, diacritic removal, and regex classification ONCE at ingest. Never evaluate regexes or string normalizations inside comparators or inner loops.
- **Single-Flight & LRU Caching:** Stream resolvers must hook into `StreamResolveCache` to enable single-flight request coalescing (preventing duplicate simultaneous scrapes) and LRU eviction.

### 2. Zero Server Bandwidth Bleed Policy
The Node.js server is a metadata and stream resolver, NOT a video CDN:
- **Never Route Through `/api/hlschunk` or Byte Proxies:** New providers and streams must NEVER rewrite segment URLs to route through `/api/hlschunk`, `/api/fastmp4`, or `/api/mp4proxy`. These endpoints stream raw video bytes through the server, saturating network interfaces and burning outbound server bandwidth.
- **Direct Client Playback:** Always emit direct stream URLs to the client with `behaviorHints.proxyHeaders` (e.g., `Referer`, `Origin`, `User-Agent`) so the user's video player fetches video directly from upstream CDNs.
- **302 Redirects Over Byte Relaying:** If URL obfuscation, dynamic token rotation, or signing is required, issue an HTTP 302 redirect to the resolved CDN URL or pre-sign the token. Only proxy lightweight text manifests (`.m3u8` rewrites) if header injection by the player is completely impossible, but all segments inside must resolve directly to upstream CDNs.
