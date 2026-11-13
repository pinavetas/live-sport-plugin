/**
 * routes/watch.js - /watch embed player page
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();
const { extractYouTubeVideoId, youtubeWatchUrl } = require('../services/YouTubeRedirect');

// Pinned player library (an unpinned @latest can change under a live page).
const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.4/dist/hls.min.js';
const FONTS_LINK = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n  ' +
  '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Inter:wght@400;600&display=swap" rel="stylesheet">';

// Shared look for the /watch pages, matching public/ui.css. Inlined so the
// page still renders when a TV webview blocks extra requests.
const WATCH_BASE_CSS = `
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0c0f; color: #eef1f5;
      font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
    .pitch { background:
      radial-gradient(900px 340px at 10% -20%, rgba(198, 255, 61, 0.10), transparent 60%),
      repeating-linear-gradient(115deg, rgba(255, 255, 255, 0.022) 0 2px, transparent 2px 14px), #0e1115; }
    .display { font-family: 'Barlow Condensed', 'Arial Narrow', 'Roboto Condensed', system-ui, sans-serif;
      font-weight: 800; line-height: 0.98; letter-spacing: 0.02em; text-transform: uppercase; }
    .spinner { width: 46px; height: 46px; border: 3px solid #364050; border-top-color: #c6ff3d;
      border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .live { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px 4px 8px; border-radius: 4px;
      background: #ff3b3b; color: #fff; font: 700 12px/1 'Barlow Condensed', 'Arial Narrow', sans-serif;
      letter-spacing: 0.14em; text-transform: uppercase; }
    .live i { width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px;
      padding: 0 22px; border: 0; border-radius: 10px; background: #c6ff3d; color: #0a0c0f;
      font: 700 17px/1 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: 0.08em;
      text-transform: uppercase; text-decoration: none; cursor: pointer; }
    .btn:hover, .btn:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
    .hint { color: #9ba5b4; font-size: 15px; line-height: 1.5; }
    #topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 10; display: flex; align-items: center; gap: 12px;
      padding: 14px 20px; background: linear-gradient(to bottom, rgba(0, 0, 0, 0.85), transparent);
      font-size: 14px; font-weight: 600; pointer-events: none; animation: fadeOut 1s ease 4s forwards; }
    @keyframes fadeOut { to { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .live i, #topbar { animation: none; } }
`;

// ─── /watch — Embed Proxy Page ────────────────────────────────────────────────

// When the user clicks a stream, Nuvio opens this URL in the browser.
// It serves a clean full-screen HTML page that wraps the embed in an iframe,
// bypassing the referrer/origin restrictions that the raw embed.st URLs have.
//
// Query params:
//   ?url=<encoded embed URL>     the stream embed to display
//   ?title=<encoded match title> shown in the page heading

router.get('/watch', (req, res) => {
  // If request contains a YouTube URL or video ID, directly redirect to YouTube (skip /watch iframe)
  // The target is always rebuilt from a validated 11-char video id on a fixed
  // YouTube host; anything else is rejected rather than redirected (open redirect).
  const str = (v) => (typeof v === 'string' ? v : '');
  const ytParam = str(req.query.ytId) || str(req.query.v);
  const candidateUrl = str(req.query.url) || str(req.query.embed) || ytParam;
  if (/youtube\.com|youtu\.be/i.test(candidateUrl) || req.query.ytId || req.query.v) {
    let decodedCandidate = candidateUrl;
    try { if (candidateUrl.includes('%')) decodedCandidate = decodeURIComponent(candidateUrl); } catch (_) {}
    const target = youtubeWatchUrl(
      extractYouTubeVideoId(candidateUrl) || extractYouTubeVideoId(decodedCandidate) || extractYouTubeVideoId(ytParam)
    );
    if (target) return res.redirect(target);
    return res.status(400).send('Invalid YouTube URL');
  }

  const mode     = req.query.mode;
  const title    = req.query.title || 'Live Sports';

  // ─── mode=extract — Client-side HLS extraction for IP-locked embed providers ─
  // Architecture: browser fetches /api/proxy-embed → runs extractor → plays via hls.js
  // This ensures all CDN requests originate from the user's own IP (IP consistency).
  if (mode === 'extract') {
    const embedUrl  = req.query.embed;
    const referer   = req.query.referer || '';

    if (!embedUrl) return res.status(400).send('Missing ?embed parameter');

    let safeEmbed, safeReferer;
    try {
      let rawEmbed = embedUrl;
      try { if (typeof rawEmbed === 'string' && rawEmbed.includes('%')) rawEmbed = decodeURIComponent(rawEmbed); } catch (_) {}
      const parsedEmbed = new URL(rawEmbed);
      if (!['http:', 'https:'].includes(parsedEmbed.protocol)) {
        return res.status(400).send('Invalid embed URL protocol');
      }
      safeEmbed = parsedEmbed.toString();
      let rawReferer = referer || safeEmbed;
      try { if (typeof rawReferer === 'string' && rawReferer.includes('%')) rawReferer = decodeURIComponent(rawReferer); } catch (_) {}
      safeReferer = new URL(rawReferer).toString();
    } catch {
      return res.status(400).send('Invalid embed URL');
    }

    const safeTitle = String(title)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>${safeTitle} | Extracting Stream</title>
  ${FONTS_LINK}
  <style>${WATCH_BASE_CSS}
    #stage { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 18px; padding: 24px; text-align: center; }
    #title { max-width: 900px; font-size: clamp(30px, 5vw, 54px); }
    #status { color: #9ba5b4; font-size: 15px; }
    #error { display: none; flex-direction: column; align-items: center; gap: 16px; }
    #error p { max-width: 380px; color: #9ba5b4; font-size: 14px; line-height: 1.5; }
    #video-player { display: none; position: fixed; inset: 0; width: 100%; height: 100%; background: #000; }
    #topbar { display: none; }
    #video-player[style*="block"] + #topbar { display: flex; }
  </style>
  <script src="${HLS_JS_URL}"></script>
</head>
<body>
  <video id="video-player" controls autoplay playsinline></video>
  <div id="topbar"><span class="live"><i></i>Live</span><span>${safeTitle}</span></div>
  <div id="stage" class="pitch">
    <span class="live"><i></i>Live</span>
    <p id="title" class="display">${safeTitle}</p>
    <div class="spinner" id="spinner"></div>
    <p id="status">Fetching stream&hellip;</p>
    <div id="error">
      <p>Could not extract a direct stream from this embed.<br>Try opening it in your browser instead.</p>
      <a id="open-btn" class="btn" href="${safeEmbed}" target="_blank" rel="noopener noreferrer">Open in browser</a>
    </div>
  </div>
  <script>
    (async () => {
      const embedUrl = ${JSON.stringify(safeEmbed)};
      const referer  = ${JSON.stringify(safeReferer)};
      const status   = document.getElementById('status');
      const spinner  = document.getElementById('spinner');
      const errorDiv = document.getElementById('error');
      const video    = document.getElementById('video-player');
      const stage    = document.getElementById('stage');

      function showError() {
        spinner.style.display = 'none';
        status.style.display  = 'none';
        errorDiv.style.display = 'flex';
      }

      function playM3u8(url) {
        stage.style.display = 'none';
        video.style.display = 'block';
        if (Hls.isSupported()) {
          // Live-window reality: these providers publish ~4 segments (~15 s) per
          // playlist. lowLatencyMode is a no-op (no EXT-X-PART) and only tightens
          // targets, so it is dropped. Syncing 2 segments back leaves ~2 segments
          // of slack inside a 4-segment window, and the max-latency ceiling (3)
          // stays below the window instead of being unreachable at 5.
          const hls = new Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 3 });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { stage.style.display = 'flex'; video.style.display = 'none'; showError(); } });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
        } else {
          showError();
        }
      }

      // ── Extraction patterns (client-side mirror of EmbedExtractorChain) ──
      function extractM3u8(html) {
        // Pattern A — plain M3U8 URL in source
        const a = html.match(/(https?:\\/\\/[^\\s"'<>]+\\.m3u8[^\\s"'<>]*)/i);
        if (a) return a[1];

        // Pattern D — JSON player config keys
        for (const k of ['source','file','src','url','hls','stream','streamUrl','hlsUrl']) {
          const d = html.match(new RegExp('["\\']' + k + '["\\'\\\\]\\\\s*:\\\\s*["\\'\\\\](https?:\\\\/\\\\/[^"\\'+]+\\\\.m3u8[^"\\'+]*)["\\'\\\\]', 'i'));
          if (d) return d[1];
        }

        // Pattern B — atob() encoded URL
        const atobRe = /atob\\s*\\(\\s*["']([A-Za-z0-9+\\/=_-]{20,})["']\\s*\\)/g;
        let m;
        while ((m = atobRe.exec(html)) !== null) {
          try {
            const decoded = atob(m[1].replace(/-/g,'+').replace(/_/g,'/'));
            if (decoded.includes('.m3u8')) {
              const u = decoded.match(/(https?:\\/\\/[^\\s"'<>]+\\.m3u8[^\\s"'<>]*)/i);
              if (u) return u[1];
            }
          } catch(_) {}
        }
        return null;
      }

      try {
        status.textContent = 'Fetching embed page\u2026';
        const proxyUrl = '/api/proxy-embed?url=' + encodeURIComponent(embedUrl) + '&referer=' + encodeURIComponent(referer);
        const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });

        if (!resp.ok) {
          console.warn('[extract] proxy-embed returned', resp.status);
          showError();
          return;
        }

        status.textContent = 'Analysing stream\u2026';
        const html = await resp.text();
        const m3u8 = extractM3u8(html);

        if (m3u8) {
          status.textContent = 'Starting playback\u2026';
          playM3u8(m3u8);
        } else {
          console.warn('[extract] No M3U8 URL found in embed HTML');
          showError();
        }
      } catch (err) {
        console.error('[extract] Error:', err);
        showError();
      }
    })();
  </script>
</body>
</html>`);
  }

  // ─── Default mode — iframe embed proxy (original behaviour, unchanged) ────
  const embedUrl = req.query.url;
  if (!embedUrl) {
    // If originalUrl contains youtube, redirect immediately
    const origMatch = req.originalUrl && req.originalUrl.match(/(?:youtube\.com|youtu\.be)[^\s&"']+/i);
    if (origMatch) {
      let fragment = origMatch[0];
      try { fragment = decodeURIComponent(fragment); } catch (_) {}
      const target = youtubeWatchUrl(extractYouTubeVideoId(fragment));
      if (target) return res.redirect(target);
    }
    return res.status(400).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>No stream | Live Sports</title>
  ${FONTS_LINK}
  <style>${WATCH_BASE_CSS}
    body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px; text-align: center; }
    h1 { font-size: clamp(30px, 5vw, 48px); }
    .hint { max-width: 420px; }
  </style>
</head>
<body class="pitch">
  <h1 class="display">No Stream URL Provided</h1>
  <p class="hint">This stream link was opened without a valid ?url parameter.</p>
  <a class="btn" href="/">Back to setup</a>
</body>
</html>`);
  }

  // Validate — only allow http/https URLs
  let safeUrl;
  try {
    let rawUrl = embedUrl;
    try { if (typeof rawUrl === 'string' && rawUrl.includes('%')) rawUrl = decodeURIComponent(rawUrl); } catch (_) {}
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('Invalid URL protocol');
    }
    safeUrl = parsed.toString();
  } catch {
    return res.status(400).send('Invalid URL');
  }

  // Never embed YouTube in an iframe — redirect directly to YouTube
  if (/youtube\.com|youtu\.be/i.test(safeUrl)) {
    const target = youtubeWatchUrl(extractYouTubeVideoId(safeUrl));
    if (target) return res.redirect(target);
    return res.status(400).send('Invalid YouTube URL');
  }

  const safeTitle = String(title)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <meta name="referrer" content="no-referrer">
  <title>${safeTitle} | Live Sports</title>
  ${FONTS_LINK}
  <style>${WATCH_BASE_CSS}
    #fs-btn {
      position: fixed; top: 12px; right: 16px; z-index: 100;
      display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px;
      border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 10px;
      background: rgba(14, 17, 21, 0.82); color: #eef1f5;
      font: 700 15px/1 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: 0.1em; text-transform: uppercase;
      cursor: pointer; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease, opacity 0.6s ease;
      user-select: none; outline: none;
    }
    #fs-btn:hover, #fs-btn:focus { background: #c6ff3d; border-color: #c6ff3d; color: #0a0c0f; transform: scale(1.05); }
    #fs-btn.fade-out { opacity: 0.15; }
    #fs-btn.fade-out:hover, #fs-btn.fade-out:focus { opacity: 1; }
    #player { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; border: none; display: block; background: #000; }
    #video-player { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; border: none; display: none; background: #000; }
    #loader {
      position: fixed; inset: 0; z-index: 5;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
      padding: 24px; text-align: center; transition: opacity 0.6s ease;
    }
    #loader.hidden { opacity: 0; pointer-events: none; }
    #loader .match { max-width: 900px; font-size: clamp(30px, 5vw, 54px); }
    #embed-fallback { display: none; margin-top: 6px; }
  </style>
  <script src="${HLS_JS_URL}"></script>
</head>
<body>
  <div id="loader" class="pitch">
    <span class="live"><i></i>Live</span>
    <p class="match display">${safeTitle}</p>
    <div class="spinner"></div>
    <p class="hint">Loading stream…</p>
    <a id="embed-fallback" class="btn" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
      Stream did not start — open in browser
    </a>
  </div>

  <div id="topbar"><span class="live"><i></i>Live</span><span>${safeTitle}</span></div>

  <button id="fs-btn" tabindex="0" title="Toggle Fullscreen (or Press OK on Remote)">
    <span>⛶ Fullscreen</span>
  </button>

  <iframe
    id="player"
    allowfullscreen
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope"
    scrolling="no"
    loading="eager"
  ></iframe>

  <video id="video-player" controls autoplay playsinline></video>

  <script>
    const fsBtn = document.getElementById('fs-btn');
    function toggleFullscreen() {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        const docEl = document.documentElement;
        const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
        if (req) req.call(docEl).catch(() => {});
        fsBtn.innerHTML = '<span>\u2715 Exit Fullscreen</span>';
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
        if (exit) exit.call(document).catch(() => {});
        fsBtn.innerHTML = '<span>\u26F6 Fullscreen</span>';
      }
    }
    fsBtn.addEventListener('click', toggleFullscreen);

    // Auto-dim button after 5 seconds of inactivity, wake up on remote key/mouse move
    let fsTimer;
    function resetFsButtonTimer() {
      fsBtn.classList.remove('fade-out');
      clearTimeout(fsTimer);
      fsTimer = setTimeout(() => {
        if (document.activeElement !== fsBtn) fsBtn.classList.add('fade-out');
      }, 5000);
    }
    window.addEventListener('mousemove', resetFsButtonTimer);
    window.addEventListener('keydown', (e) => {
      resetFsButtonTimer();
      // If user presses Enter or Space while focusing the body, toggle fullscreen
      if ((e.key === 'Enter' || e.key === ' ' || e.keyCode === 13) && document.activeElement === document.body) {
        toggleFullscreen();
      }
    });
    resetFsButtonTimer();

    const loader = document.getElementById('loader');
    const iframe = document.getElementById('player');
    const video = document.getElementById('video-player');
    const targetUrl = "${safeUrl}";
    const isM3u8 = targetUrl.includes('.m3u8');
    
    // Video streams play DIRECT from the upstream CDN (no server-side relay).
    let finalUrl = targetUrl;

    // >>> TV-SAFE PLAYBACK: graceful degradation
    // TV WebViews vary widely: many lack Web Workers or block the cross-origin
    // CDN script. Any throw used to abort this whole script, leaving a permanent
    // spinner - reported as a "sandbox error" on TV. Each capability is
    // feature-detected, and every failure falls through to the next strategy.
    function showFatal(msg) {
      loader.classList.remove('hidden');
      var hint = loader.querySelector('.hint');
      if (hint) hint.textContent = msg;
      var fb = document.getElementById('embed-fallback');
      if (fb) fb.style.display = 'inline-flex';
    }

    function startHls(opts) {
      var hls = new Hls(opts);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        loader.classList.add('hidden');
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      });
      hls.on(Hls.Events.ERROR, function (evt, data) {
        if (data && data.fatal) {
          console.warn('[player] fatal HLS error:', data.type, data.details);
          showFatal('Playback error: ' + (data.details || data.type));
        }
      });
      hls.loadSource(finalUrl);
      hls.attachMedia(video);
      return hls;
    }

    if (isM3u8) {
      iframe.style.display = 'none';
      video.style.display = 'block';
      var started = false;

      // 1) hls.js, worker disabled for maximum TV compatibility.
      if (!started && window.Hls && Hls.isSupported()) {
        try {
          startHls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 3,
                     enableWorker: false });
          started = true;
        } catch (e) {
          console.warn('[player] hls.js failed:', e && e.message);
        }
      }

      // 2) Native HLS (Safari/iOS and some TV engines).
      if (!started && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = finalUrl;
        video.addEventListener('loadedmetadata', function () {
          loader.classList.add('hidden');
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
        });
        video.addEventListener('error', function () { showFatal('Native playback failed'); });
        started = true;
      }

      if (!started) showFatal('No compatible video player on this device');
    } else {
      video.style.display = 'none';
      let iframeLoaded = false;
      iframe.src = targetUrl;
      iframe.addEventListener('load', () => {
        iframeLoaded = true;
        loader.classList.add('hidden');
      });
      // A blocked, hung or black-holed embed may never fire its load event at all.
      // Rather than freezing on an eternal spinner, reveal a manual escape hatch
      // so the user always has a way to reach the stream.
      setTimeout(() => {
        if (iframeLoaded) return;
        loader.classList.add('hidden');
        const fallback = document.getElementById('embed-fallback');
        if (fallback) fallback.style.display = 'inline-flex';
      }, 12000);
    }
  </script>
</body>
</html>`);
});

// ─── /api/sniff — Headless Browser Sniffer Endpoint ───────────────────────────
router.get('/api/sniff', async (req, res) => {
  const target = req.query.url;
  const referer = req.query.referer || '';
  if (!target) return res.status(400).json({ success: false, error: 'Missing ?url parameter' });
  try {
    const container = require('../container');
    let sniffer = null;
    try { sniffer = container.resolve('puppeteerSnifferService'); } catch (_) {}
    if (!sniffer || !sniffer.isAvailable()) {
      return res.status(503).json({ success: false, error: 'Headless sniffer not available' });
    }
    const result = await sniffer.sniff(target, { referer, timeoutMs: 15000 });
    if (result && result.file) {
      return res.json({ success: true, url: result.file, type: result.type, headers: result.headers });
    }
    return res.status(404).json({ success: false, error: 'Stream not found' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
