# Stremio / ExoPlayer playback failure — root cause and fix

Status: fixed and confirmed playing on the device (Stremio 2.4.0, Android).
Scope: live streams from Streamed.pk, PPV.st and DamiTV (ST-DAMITV) failing in Stremio/ExoPlayer while
DaddyLive played fine and everything played in MPV and Nuvio.

---

## 1. What the players were actually given

Both the working and the failing providers are handed the **same stream-object shape**: a proxied
`/api/manifest?url=...` URL with `behaviorHints.notWebReady: false` and no `proxyHeaders`.
Measured on a live match (`spk_tijuana-vs-santos-laguna-2487577`), all nine resolved streams looked
like this:

```
⚡ Direct Stream  http://<addon>/api/manifest?url=https%3A%2F%2Flb24.strmd.st%2F...%2Fplaylist.m3u8
                 behaviorHints: { notWebReady: false, bingeGroup: "nuvio_sport_..." }
```

So the addon metadata is **not** the difference — and that is why commit `1e2cde4`
(`notWebReady` normalisation + `#EXT-X-VERSION:4`) could not fix playback: those flags were already
correct for these providers, and the manifest was already being served.

## 2. Where the playlists diverge

Two playlists fetched through the addon, same moment, same route:

| | DaddyLive (works in Stremio) | Streamed.pk / PPV / DamiTV (failed) |
|---|---|---|
| `#EXT-X-VERSION` | `3` | `4` (injected by `1e2cde4`) |
| Segment addressing | `#EXTINF` + absolute CDN `..._458.ts` | `#EXT-X-BYTERANGE:<len>@42` + `<addon>/api/hls/resource/<token>/media.ts?psig=...` |
| Requests per segment | 1, straight to the CDN | 1 with a `Range` header, answered by **our 307** back to the CDN |
| Redirect | none | addon endpoint → https CDN (cross-protocol only when the addon is on http) |

The failing providers use the "cloaked segment" trick: the CDN stores MPEG-TS behind a fake 42-byte
WebP/RIFF header, so the playlist declares `#EXT-X-BYTERANGE:<len>@42` and points at our signed 307
endpoint, which bounces the player's `Range` request to TikTok CDN.

The manifest itself is valid HLS and ExoPlayer supports `#EXT-X-BYTERANGE` natively, so the manifest
was never the blocker. **The blocker is the extra hop.**

## 3. Root cause

> **Superseded for the observed Android failure.** A device bug report showed the player never
> reached HLS at all — see §7, which is the failure this document now resolves.

The failure sits in the one thing the working provider does not have: a per-segment redirect.

**Local / LAN deployment (addon on http) — reproduced and explained.** `config.js` falls back to
`http://<lan-ip>:<port>` when `ADDON_URL` is unset, while every cloaked segment lives on
`https://…tiktokcdn.com`. That is a cross-protocol redirect, and ExoPlayer refuses it by design:

> "An HttpDataSource that uses Android's HttpURLConnection. **By default this implementation will not
> follow cross-protocol redirects.**"
> — [`androidx.media3.datasource.DefaultHttpDataSource`](https://developer.android.com/reference/androidx/media3/datasource/DefaultHttpDataSource)

Every segment reached ExoPlayer as a bare `307`, and playback died on the first one.

**Hosted deployment (`https://nuviosports.xyz`, addon on https) — the hop still has to survive.**
There the `Location` is https→https, which a player does follow, so the cross-protocol path does not
apply. What remains is that the redirect only works if the player carries its `Range` header through
it. Measured on the CDN: a request **with** the declared range returns `206` plus the TS payload; the
same request **without** it returns the full 2 866 666-byte object starting `RIFF` — the fake WebP
wrapper. A player that drops `Range` at the redirect therefore gets a WebP file where it expects
MPEG-TS. Confirming which of the two a given Stremio build does needs the device; the fix below
removes the question rather than answering it.

Either way the conclusion is the same: **the redirect was the only fragile element in the chain, and
it never bought anything** — in the 307 flow it is the *player* that re-requests the CDN with its own
headers, so all our endpoint added was a hop. Verified on the live segment, the CDN needs none of our
headers:

| Probe | Result |
|---|---|
| `Range: bytes=42-…`, no `Referer`, generic UA | `206`, exact `Content-Range`, payload starts `0x47` (TS sync) |
| same with ExoPlayer's `stagefright/1.2` UA | `206`, identical bytes |
| same with `Origin: https://web.stremio.com` | `206` + `Access-Control-Allow-Origin: *` |
| `OPTIONS` preflight | `200`, `Access-Control-Allow-Origin: *` |
| no `Range` at all (player ignores BYTERANGE) | `200`, 2 866 666 bytes, starts `RIFF` — i.e. WebP, as expected |

Ruled out along the way: DRM/encryption (none present), codec mismatch, CORS, `Referer`/`User-Agent`
requirements, malformed manifests, and the `notWebReady` flags.

## 4. The fix

`src/services/HlsRewriteService.js` — cloaked segments are now addressed **directly**:

```
#EXTINF:6.006,
#EXT-X-BYTERANGE:4698496@42
https://p16-common-sign.tiktokcdn.com/tos-alisg-...image?dr=14575&x-expires=...&x-signature=...
```

The player range-requests the CDN itself; TikTok's edge slices the 42 fake WebP bytes off, so server
bandwidth stays at 0 KB/s. No redirect, no header injection, no proxy.

- `segmentAddressMode()` resolves the addressing mode: `direct` (default), `redirect` (the old 307
  hop), `proxy` (CF worker / `/api/hlschunk`).
- `USE_TIKTOK_BYTERANGE_307=off` keeps its historical meaning (`proxy`), so existing deployments
  behave as before.
- `TIKTOK_SEGMENT_MODE` documents/overrides the mode (see `.env.example`).
- `route /api/hls/resource` and `ByteRangeSigner` are kept intact for `redirect` mode.
- The `#EXT-X-VERSION:4` injection from `1e2cde4` is kept — it is genuinely required for
  `#EXT-X-BYTERANGE` (RFC 8216 §7), it simply was not the cause.

Files changed:

| File | Change |
|---|---|
| `src/services/HlsRewriteService.js` | `segmentAddressMode()`; direct URI emitted by default in `rewriteHlsUri` and `rewriteHlsPlaylist`; header docs |
| `tests/hlsRewritePlaylist.test.js` | asserts the CDN URI is emitted, plus a `redirect` mode test that still verifies the signed token |
| `tests/hlsRewriteService.test.js` | default-mode assertions updated; version/byte-range contract covered |
| `.env.example` | documents `TIKTOK_SEGMENT_MODE` |

## 5. Verification

Live, against the running addon, on the real match above — each segment fetched with the exact
`Range` the playlist declares:

| Provider | Segments | Result | Declared == received | TS sync |
|---|---|---|---|---|
| ⚽ PPV.st | 4 | `206` | yes (3393024, 4259328, 4090880, 4349568) | yes |
| ⚽ DamiTV | 4 | `206` | yes | yes |
| ⚽ Streamed.pk | 4 | `206` | yes | yes |
| 📺 DaddyLive (control) | — | unchanged: `#EXT-X-VERSION:3`, no byte ranges, direct `.ts` | n/a | n/a |

All three previously-failing providers now emit `#EXT-X-VERSION:4` + `#EXT-X-BYTERANGE` + the CDN URL,
with no `/api/hls/resource` hop anywhere in the playlist.

Unit tests: 38/38 in `hlsRewriteService`, `hlsRewritePlaylist`, `hlsResource`, `manifestWebReady`.
Full suite: 1165 passed, 3 suites failing (`ak47LiveProvider`, `beforeAndAfterBenchmark`,
`safeFetchTotalDeadline`) — all three fail identically on a clean tree (`git stash` baseline) and do
not touch the rewrite path.

## 6. Remaining limitations

1. **Confirmed on one client.** Playback is verified on Stremio 2.4.0 / Android. Other player
   builds are reasoned about from the same evidence, not tested individually.
2. **Depends on the player honouring `#EXT-X-BYTERANGE`.** ExoPlayer, MPV and hls.js all do. A client
   that ignores it receives the raw 42-byte-prefixed WebP object — that has always been true of this
   design, redirect or not.
3. **Byte length is estimated until probed.** `SegmentLengthService` pre-probes the live-edge segments
   (1.5 s budget) and returns an aligned bitrate estimate for the rest; an estimate that is short
   truncates a segment tail. Pre-existing, and a wrong length is now read by ExoPlayer directly rather
   than through one of our endpoints.
4. **Serve the addon over HTTPS.** If `ADDON_URL` is unset the addon advertises `http://<lan-ip>`, which
   Stremio Web (https) will block as mixed content even though native players accept it.

## 7. Update — device log evidence (Stremio 2.4.0, Media3 1.10.1-stremio01)

An Android bug report from a test phone changed the diagnosis. All five failed attempts carry:

```
UnrecognizedInputFormatException
  at androidx.media3.extractor.ProgressiveMediaPeriod$ExtractingLoadable.load
```

`ProgressiveMediaPeriod` means the player never selected HLS: it built a **progressive** media
source and handed the playlist text to the extractor chain, which correctly refused it. On Android,
ExoPlayer picks the source type from the URI (`Util.inferContentType`), and
`…/api/manifest?url=…` carries no recognisable extension — the last path segment is `manifest`.
The addon's `Content-Type: application/vnd.apple.mpegurl` never gets a say at that point.

So the active failure is type inference, not the byte-range transport. The change in §4 stays
worth having — it removes a hop a strict player can fail on — but it could not have fixed this
symptom, and did not.

Fix (from the prepared experiment, applied here):

- `src/services/ManifestPlaybackUrl.js` — rewrites only the *published* playback URL
  (`https://<addon>/api/manifest` → `…/api/manifest.m3u8`), preserving the raw query (nested
  signed CDN URL, `referer`, `origin`, `rck`) and fragment. Third-party URLs, DASH targets,
  already-suffixed URLs and malformed input pass through untouched.
- `src/routes/manifest.js` — `/api/manifest.m3u8` registered as an alias of the existing handler,
  with no redirect and no second upstream fetch.
- `src/streams.js` — applied after `withResolveKey`, so cached provider URLs and recovery keys
  keep their original form.

Measured locally: published path `/api/manifest.m3u8`, `rck` present, `url` param intact; old and
new paths both `200`, both `application/vnd.apple.mpegurl`, byte-identical bodies; segments
direct-CDN. `node --test tests/manifestPlaybackUrl.node.test.cjs` 7/7; jest 1174 passed with only
**Confirmed on the phone**: playback works with the suffixed path.

## 8. Rollback

`TIKTOK_SEGMENT_MODE=redirect` restores the previous 307 behaviour without a code change.
