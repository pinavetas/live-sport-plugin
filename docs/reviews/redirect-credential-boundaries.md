# PR #29 — fixed-name policy and provider compatibility

Base stable: 50611f7157571878e70582da310bbf2a8e538ed7, rechecked October 26, 2026.
Original Draft #29 head: fef52b88de5ab58ead7b012e313c9044ba0f1536.
This follow-up targets that existing Draft; no deployment is performed.

## Exact boundary

The manual Undici redirect path removes a fixed case-insensitive name set on
an origin change: Authorization, Cookie, Cookie2, Proxy-Authorization and Host.
Origin includes scheme, hostname and effective port. Same-origin redirects
preserve caller headers; 307/308 retain their existing method/body semantics.

This is not general credential detection. Provider-specific X-Api-Key-style
headers, Referer, Origin and other custom headers remain present. URL/query
credentials and native Impit automatic redirect behavior are not addressed by
this policy. The separate shared outbound guard is still incomplete.

Removed headers stay removed on A -> B -> A. A real local fixture accepts a
direct authenticated request to A but returns 401 when the request goes via B
and returns to A without Authorization. That demonstrates the compatibility
tradeoff; it is not proof that any named production provider needs such a chain.
The policy is documented rather than silently restoring original credentials.

## Verification

36 tests passed across redirectCredentialIsolation, redirectCredentialHttp and
impitRedirect, normal process exit. Real HTTP fixtures are constrained to their
loopback ports; other transport is mocked. The real tests now explicitly show
that X-Api-Key survives cross-origin hops in supported header representations,
including a return to the original origin.

The first combined run did not consistently select the native Impit mock.
The credential suites now use the installed module identity consistently with
the existing redirect suite, and all three assert that native Impit is disabled
before issuing requests. The passing result is the final isolated run; the
earlier failure is not evidence of a production playback regression.

No production behavior beyond the original #29 policy changed in this follow-up:
it clarifies comments and adds compatibility/isolation coverage. No live provider
playback, native TLS compatibility, PM2 deployment or full CI/build was tested.
Provider compatibility review remains required. Zero Bandwidth Bleed is unchanged.
