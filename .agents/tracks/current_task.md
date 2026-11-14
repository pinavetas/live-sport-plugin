# Session Checkpoint: Plooplayer provider (per-install W3U list + local ClearKey decryptor)
**Date**: 2026-11-14
**Status**: Implemented on branch `feat/plooplayer-provider` (not committed, not deployed)

### What Was Completed
- New per-install provider: the user pastes a Plooplayer list URL in `/configure` (`plooplayerList`);
  the add-on shows one row per top-level group (type `Plooplayer`, ids `ploo_*`), deeper groups as
  the row's genre filter, quality/server variants merged into one channel. See `docs/PLOOPLAYER.md`.
- ClearKey DASH plays through a **local decryptor** on the viewer's TV (Termux) or LAN
  (`plooplayerDecryptor`), served as one file by `GET /plooplayer/decryptor.js`. The add-on emits
  URLs only — I1/I8 untouched (owner decision 2026-11-14: Vercel, no server relay).
- AceStream entries → `externalUrl` (`acestream://`); HLS → direct URL + `proxyHeaders`.
- Reuse changes: `DashToHlsService` loads fast-xml-parser/ProviderOutbound lazily, accepts
  `xmlParser` and `routePrefix`; `cenc/init.parseTenc` accepts several expected KIDs;
  `serverless` cold-start gate skips `Plooplayer` requests.

### Verification Record
- `npm test -- tests/plooplayer*` + DASH/config/serverless suites: 18 suites, 204 tests passed.
- Live E2E (real list, local add-on with `NODE_APP_INSTANCE=1`, decryptor downloaded from the
  add-on): manifest 2 rows (22 + 66 channels, 19 filters); DAZN 1 (4 KIDs) and SKY sports 16
  init+segment decrypted; `ffmpeg -v error` on video (h264 1080p) and audio (aac): no errors.

### Open
- Not yet tried on a real Android TV (Termux + Stremio/Nuvio player) — next step for the owner.
- `npm run build` (ncc dist) lacks the sources `/plooplayer/decryptor.js` bundles → 503 there.
