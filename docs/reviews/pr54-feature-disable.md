# PR #54 follow-up — feature-only failure

Local candidate based on stable 50611f7157571878e70582da310bbf2a8e538ed7.
The existing Draft #54 head was rechecked at
e2a9307a95034332f755a93bbcc4dce2e6d76c19. Its signer/configuration/test changes
were applied before this follow-up. It is intended for the existing Draft #54;
no deployment has been performed.

## Reproduced

With NODE_ENV=production and APP_SECRET/SESSION_SECRET absent, #54's signer
throws during require(). A local Node reproduction exited with status 1.
This confirms Raj's startup concern without needing provider access.

## Candidate behavior

- Production without a secret logs a fatal configuration message once on
  module initialization, disables the default signer, and does not throw at
  module load. It generates no process-local production fallback key.
- Explicit signing attempts fail with ERR_HLS_SIGNING_DISABLED; verification
  returns null. The former public secret cannot enable the default signer.
- Both signed-resource aliases return 503 with Cache-Control: no-store and
  no Location header, including HEAD requests.
- Both single-URI and full-playlist rewriting fall back from the configured
  redirect mode to the existing direct-CDN behavior, preserving byte ranges.
  No media proxy or worker fallback is enabled by this change.
- Configured shared APP_SECRET/SESSION_SECRET and development random-key
  behavior are retained. Configuration is read at module load: restart all
  workers after setting the shared secret.

## Verification

19 tests passed across four suites, normal exit:
byteRangeSignerSecret, byteRangeSignerAvailability, byteRangeSigner, hlsResource.
The availability suite mounts the actual health and redirect routers on
listen(0), stubs container services and segment-size probes, and uses loopback
HTTP with redirects disabled. It checks healthy responses, disabled GET/HEAD
aliases, full-manifest byte-range preservation, working configured signatures
and tampering rejection. No provider or video requests are required.

This verifies module/route failure isolation, not a complete PM2 deployment
or full index.js startup. The broader HLS suites were not accepted as completed
validation: automatic approval review stopped their execution because of
possible unverified external Workers traffic. Verification was narrowed to
the local/mocked suites above; no bypass or further broad attempt was made.

The separate shared outbound-guard candidate remains in progress. This
signer follow-up does not settle native Impit DNS pinning or TLS fingerprint
compatibility and does not alter pending PR #27/#52 caching work.
