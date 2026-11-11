# Fence shared-cache publications and releases by lease owner

Branch: fix/shared-cache-lease-ownership
Base branch: stable. Prerequisite PR #20 (claim cleanup) was merged on October 13, 2026.
Review this PR against stable, not the former intermediate branch. This branch does not include the
other pending expiry, pending-prune, or response-deadline branches.

## Reproduced race

Worker A acquires a reservation and starts resolving. Its reservation expires,
then worker B acquires a new reservation for the same key and publishes a result.
Previously A could later overwrite B with an old positive/negative answer, or
its failure handler could unconditionally DELETE B's result or active claim.

The original audit identified failing stale-owner cases before the fix.
Raj subsequently identified a slow-mint regression: after 30 seconds, even
an uncontested owner gets stale-owner and cannot publish to L2. A controlled
clock reproduction confirmed that rejection with the current PR #21 code.

This follow-up is based on stable 50611f7157571878e70582da310bbf2a8e538ed7
with the original PR #21 applied. It is intended for the existing Draft #21;
no deployment has been performed.

## Change

- Opt into fenced reservations with GET ?claim=1&fenced=1.
- Return a fresh ownerToken for each fenced acquisition.
- Require the current unexpired owner token for token-bearing POST/DELETE.
- Reject missing tokens while a fenced reservation is active.
- Include the token in worker publications and provider-exception releases.
- Preserve expired-reservation cleanup from PR #20.
- Clamp claim TTLs to 5–120 seconds and cap active claims at 1,000. Reclaim
  expired slots at capacity, but never evict an active owner. Capacity denial
  allows local minting without the unrelated eight-second ownership wait.
- After an explicit stale-owner write rejection, permit one fresh acquisition
  with ?claim=1&fenced=1&vacant=1, followed by one publication attempt.
  The resolver atomically refuses the acquisition if a live positive/negative
  cache entry or another active reservation exists. The default TTL stays 30s;
  this is bounded re-acquisition, not indefinite background lease renewal.
- Advertise supportsVacantClaim in fenced responses and confirm vacantOnly
  on recovery. Workers never assume an older resolver understands the flag.

A worker using an older resolver that grants claims without owner tokens keeps
local resolution/caching but skips unsafe shared publication/release. Legacy
unfenced API calls remain supported for compatibility.

The owner identifier is a correctness mechanism, not an authentication system.

## Scope and rollout

Deploy the updated worker and resolver together to enable ownership protection.
Old workers remain unfenced; legacy operations without an active fenced claim
retain their prior behavior, so a mixed-version rollout does not provide universal
protection. An old resolver may retain a claim until its normal TTL while updated
workers use local-only results.

The protection applies to shared L2 publication and claim release by updated
workers. Local L1 caches are not globally invalidated: a late worker can still
cache its own locally resolved stream even if L2 rejects its publication.
This does not implement provider cancellation, ongoing claim renewal, distributed prune
cancellation, or ownership-aware health invalidations of already published entries.

## Validation (local follow-up, October 26, 2026)

46 tests passed across eight suites, normal process exit: sharedClaimHttp,
sharedClaimBounds, sharedSlowMintRecovery, sharedClaimCleanup,
sharedLeaseOwnership, sharedLeaseProtocol, pendingMintPruning, sharedCacheExpiry.

Coverage includes slow positive/negative results shared with a second worker,
preservation of newer results and owners, rejection at capacity, TTL bounds,
expired-slot recovery, old-resolver fallback and a second expired lease ending
without a retry loop. Existing expiry and pending-prune protections pass.

The HTTP fixture uses the actual worker, actual router source and actual cache
on listen(0). Provider-resolution/static dependencies are substituted at the
ESM boundary; provider modules are not imported. Its fetch wrapper rejects any
origin except the local fixture. Other new tests use a controlled clock and
stubbed HTTP, so there is no provider or media traffic.

The existing full resolver-server suite was preserved but not run in this
block. No live provider playback, PM2 deployment or full CI/build was tested.
The old PR description/test counts do not describe this local follow-up.

## Dependencies and remaining limits

- The owner token is a concurrency safety mechanism, **not** authorization.
  Apply the separate private resolver API protections (#55) before
  relying on this in an exposed deployment.
- Do not assume atomicity across multiple process versions: update worker
  and resolver together, ideally first in staging.
- This patch guards normal L2 claim publication/release; it does not protect
  every independent health invalidation or local L1 cache from stale writes.
- No video segments or other media bytes are relayed through the VPS.
