# ExoPlayer HLS path experiment — local only

Base: upstream stable `1e2cde4cf2fe7603deaec5546c19d3f5c3faf0c9`.
This is a partial source snapshot. No PR or deployment was made.

## Evidence

The supplied Android bug report contains five Stremio playback failures with
`UnrecognizedInputFormatException`, all through
`ProgressiveMediaPeriod$ExtractingLoadable.load`. The installed application is
Stremio 2.4.0 and logs Media3 `1.10.1-stremio01`.

The selected stream URLs point at `/api/manifest` and carry a Streamed.pk
recovery key. An exact URL comparison associates the latest selected URL with
MPV's subsequent opening of the same URL. MPV identifies
`application/vnd.apple.mpegurl` and starts requesting playlists and segments.
The report does not establish full uninterrupted MPV playback or PPV.st's
separate failure cause. No signed URLs or unrelated phone logs are included.

The evidence supports testing HLS type inference. It does not prove that an
extension alone resolves every playback failure or that ExoPlayer received
the same response body at the earlier attempt.

## Candidate

Register `/api/manifest.m3u8` as an alias of the existing handler, without an
HTTP redirect. Publish this path for HLS wrappers on the configured addon
origin. Preserve the raw query and fragment, including nested signed CDN URLs
and `rck`. Apply the change after recovery keys are assigned; provider cache
entries retain their original URL. Existing child-playlist paths remain valid.

The original route, playlist rewrite, media redirects and current playback
flags retain their existing behavior. CDNLive's separate expiry candidate is
not included here. Unknown, third-party and DASH URLs are not rewritten.

## Local validation

`node --test tests/manifestPlaybackUrl.node.test.cjs`: seven tests passed.
These exercise URL preservation, the actual publication block, handler
registration, master-child recovery metadata and real loopback HTTP requests
through the actual route and HLS rewriter. Framework, cache and upstream
metadata dependencies are mocked. The two paths return identical rewritten
playlists and MIME headers, with one simulated upstream playlist fetch.
No external media requests are made. The full app build, Jest suite and
Android playback have not run in this partial snapshot.

The relevant diffs in open PRs #27, #30 and #52 do not contain this alias.
That is an overlap review, not a combined merge/build validation.

## Next real-device test

Raj needs to install the candidate in a test environment. Confirm that a
fresh addon stream response actually contains `/api/manifest.m3u8`; changing
an unused server route alone does not test player inference. Compare the
same fresh upstream stream on ExoPlayer with the old and new published paths,
keeping player, headers and other settings constant. Capture the new log.

Success requires actual audio/video playback. If the new path instead reaches
HLS loading and fails later on a segment or HTTP request, diagnose that new
failure separately. This experiment does not fix header injection, estimated
byte-range lengths, expiring URLs or IP-bound upstream authorization.
