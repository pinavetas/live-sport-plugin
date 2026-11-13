# PR #30 — verification header boundary

Based on stable 50611f7157571878e70582da310bbf2a8e538ed7, rechecked on October 26.
Original Draft #30 head: 16ab2618742540ca13dea98e0ac0ad1a939c8122.
This follow-up is intended for that existing Draft; no deployment is performed.

## Reproduced and changed

The original PR copied every provider request header into the verification GET
and its Referer-repair retry. Controlled tests confirmed that Host, connection
fields and request framing were forwarded unchanged.

verificationHeaders now excludes Host, Connection, Keep-Alive, Proxy-Connection,
Proxy-Authenticate, Proxy-Authorization, TE, Trailer, Transfer-Encoding, Upgrade,
Content-Length and Expect. It also excludes headers nominated by Connection,
using case-insensitive names. The HTTP transport generates its own Host and
framing for the target URL.

This is a transport-header denylist, not a fixed provider-header allowlist.
Authorization, Cookie, Referer, Origin, User-Agent and custom provider tokens
remain available unless explicitly nominated as connection-only fields.
Provider-owned header objects are not mutated. Accepted Referer repairs reuse
the filtered request headers and retain the existing URL/metadata behavior.

Scope remains the verification request and its repair. This is not a universal
playback-header sanitizer or a cross-origin credential policy. In particular,
PR #29's provider-specific credential limitations and the manifest proxy's
existing credential-forwarding boundary remain separate work.

## Validation

44 tests passed across four suites, normal exit: streamVerificationHeaderFilter,
streamPlaybackHeaders, streamHeaderBoundary, streamPlaybackHeadersHttp.

The 15 new unit cases failed against the original PR's unrestricted forwarding
and passed after filtering. An additional real loopback HTTP test verifies that
the server receives the actual target Host, retains required provider headers,
and receives no provider framing or Connection-nominated private header.
All outgoing transport is mocked or constrained by the HTTP fixture's loopback
socket guard. Speed probes are disabled in these cases; no media is downloaded.

Existing credential preservation, accepted/refused repair, response hints,
header casing and manifest-proxy boundary cases pass. No production provider
playback, TLS fingerprint compatibility, PM2 deployment or full CI/build was
tested. Zero Bandwidth Bleed is unchanged.
