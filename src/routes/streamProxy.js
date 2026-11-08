/**
 * routes/streamProxy.js - byte-streaming proxies (/api/fastmp4, /api/mp4proxy, /api/hlschunk)
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const http = require('http');
const { pipeline, Readable } = require('stream');
const https = require('https');
const { checkOutboundUrl, rejectBlockedUrl } = require('../services/OutboundUrlGuard');
const adaptiveDnsResolver = require('../services/AdaptiveDnsResolver');
const router = express.Router();

const hlsChunkHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 15000,
  lookup: (hostname, opts, cb) => adaptiveDnsResolver.lookup(hostname, opts, cb)
});
const hlsChunkHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 15000,
  lookup: (hostname, opts, cb) => adaptiveDnsResolver.lookup(hostname, opts, cb)
});

// Range-aware MP4 proxy for ok.ru direct video files
// ─── /api/fastmp4 — parallel-range MP4 proxy ─────────────────────────────
// ok.ru throttles each connection to roughly 226 KB/s (~1.8 Mbps) but does NOT
// throttle per IP: measured 1/2/4/8 connections = 226/451/887/1792 KB/s, i.e. a
// near-linear ~7.9x at 8. A single-connection player therefore cannot sustain
// 1080p from these links, which is what makes ReplayZone replays buffer.
//
// This endpoint fetches the requested byte range as several parallel sub-ranges
// and streams them back IN ORDER, multiplying effective throughput. Correctness
// (byte-for-byte ordering) matters more than speed here, so a strictly ordered
// writer is used rather than a naive parallel pipe.
//
// Defaults: 6 connections x 1 MB chunks. Bounded memory (~6 MB in flight) and a
// deliberate cap so a single viewer cannot stampede the upstream.
// ─── Redirect-safe fetch ──────────────────────────────────────────────────
// checkOutboundUrl() only vets the URL it is given. fetch() follows redirects on
// its own by default, so a public URL answering `302 Location:
// http://169.254.169.254/` would otherwise be dialled without ever being
// checked. Redirects are therefore followed by hand, a bounded number of times,
// and every Location is put through the same gate before it is requested.
const MAX_PROXY_REDIRECTS = 5;

async function fetchFollowingCheckedRedirects(url, init = {}, maxRedirects = MAX_PROXY_REDIRECTS) {
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = isRedirect ? response.headers.get('location') : null;
    if (!location) return response;

    // The redirect body is never used; release its socket.
    try { if (response.body) await response.body.cancel(); } catch (_) {}

    if (hop >= maxRedirects) {
      const err = new Error(`too many redirects (> ${maxRedirects})`);
      err.statusCode = 502;
      throw err;
    }
    let next;
    try {
      next = new URL(location, current).toString();
    } catch (_) {
      const err = new Error('invalid redirect location');
      err.statusCode = 502;
      throw err;
    }
    const verdict = await checkOutboundUrl(next);
    if (!verdict.ok) {
      const err = new Error(`redirect blocked (${verdict.reason})`);
      err.blockedVerdict = verdict;
      throw err;
    }
    current = next;
  }
}

const FASTMP4_CHUNK = 1 * 1024 * 1024;
const FASTMP4_CONCURRENCY = 6;

function parseClientRange(rangeHeader, total) {
  // 'bytes=start-end' | 'bytes=start-' ; returns {start,end} or null
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return null;
  let [, s, e] = m;
  let start = s === '' ? null : parseInt(s, 10);
  let end = e === '' ? null : parseInt(e, 10);
  if (start === null && end === null) return null;
  if (start === null) { // suffix range: last N bytes
    start = total != null ? Math.max(0, total - end) : 0;
    end = total != null ? total - 1 : null;
  }
  if (Number.isNaN(start)) return null;
  if (end != null && Number.isNaN(end)) end = null;
  if (end != null && end < start) return null;
  return { start, end };
}

// Per-chunk deadline. ok.ru serves ~226 KB/s per connection, so the default
// 1 MB chunk needs ~5 s; the ceiling scales with the chunk size (4 MB max) so a
// slow-but-alive connection is not cut, while a stalled one cannot pin a
// concurrency slot and its socket until undici's 300 s body timeout.
const FASTMP4_CHUNK_TIMEOUT_MS = 20000;
const FASTMP4_MIN_BYTES_PER_SEC = 100 * 1024;

function chunkTimeoutMs(bytes) {
  return Math.max(FASTMP4_CHUNK_TIMEOUT_MS, Math.ceil(bytes / FASTMP4_MIN_BYTES_PER_SEC) * 1000);
}

/**
 * Read at most `maxBytes` from a fetch() Response body, then cancel the rest.
 * Never buffers more than asked for, whatever the upstream decides to send.
 */
async function readCapped(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  let finished = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      const take = Math.min(value.length, maxBytes - total);
      parts.push(Buffer.from(value.buffer, value.byteOffset, take));
      total += take;
    }
  } finally {
    if (!finished) {
      try { await reader.cancel(); } catch (_) {}
    }
  }
  return Buffer.concat(parts, total);
}

async function fetchRangeBuf(url, start, end, headers, signal) {
  try {
    const wanted = end - start + 1;
    const r = await fetchFollowingCheckedRedirects(url, {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(chunkTimeoutMs(wanted))]),
    });
    // A sub-range MUST come back as 206. A 200 means the upstream ignored the
    // Range header and is sending the whole file from byte 0: that is only the
    // right data when this chunk itself starts at 0 (and only its first
    // `wanted` bytes are read). Anything else would splice the wrong bytes into
    // the stream — and used to buffer an entire multi-GB file per chunk.
    let ok = r.status === 206 || (r.status === 200 && start === 0);
    if (ok && r.status === 206) {
      const m = /bytes\s+(\d+)-/i.exec(r.headers.get('content-range') || '');
      if (m && parseInt(m[1], 10) !== start) ok = false;
    }
    if (!ok) {
      try { if (r.body) await r.body.cancel(); } catch (_) {}
      const err = new Error(`upstream ${r.status} for range ${start}-${end}`);
      err.statusCode = r.status;
      throw err;
    }
    return await readCapped(r, wanted);
  } catch (e) {
    // On client disconnect we abort() the whole batch. Those rejections are
    // expected and already handled at the await site, but the not-yet-awaited
    // siblings would otherwise surface as unhandledRejection. Mark them handled.
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
      e.__expected = true;
    }
    throw e;
  }
}

router.get('/api/fastmp4', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://ok.ru/';
  if (!targetUrl) return res.status(400).send('Missing url');

  // SSRF gate — must run before the probe below, which is the first outbound request.
  const verdict = await checkOutboundUrl(targetUrl);
  if (!verdict.ok) return rejectBlockedUrl(res, verdict, 'FastMP4');

  const concurrency = Math.min(
    Math.max(parseInt(req.query.concurrency, 10) || FASTMP4_CONCURRENCY, 1), 12
  );
  const chunkSize = Math.min(
    Math.max(parseInt(req.query.chunk, 10) || FASTMP4_CHUNK, 256 * 1024), 4 * 1024 * 1024
  );

  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Referer': referer,
    'Accept': '*/*',
  };

  // Probe with a 1-byte range to learn the real Content-Range/total length.
  let total = null;
  let contentType = 'video/mp4';
  try {
    const probe = await fetchFollowingCheckedRedirects(targetUrl, {
      headers: { ...upstreamHeaders, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15000),
    });
    if (probe.status !== 206 && probe.status !== 200) {
      return res.status(probe.status === 400 ? 502 : probe.status).send('upstream refused');
    }
    const cr = probe.headers.get('content-range');
    if (cr) {
      const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(cr);
      if (m && m[1] !== '*') total = parseInt(m[1], 10);
    }
    if (probe.headers.get('content-type')) contentType = probe.headers.get('content-type');
    // Drain the 1-byte body without trusting the upstream to honour Range: a
    // 200 here is the whole file, which must not be buffered.
    try { await readCapped(probe, 1); } catch (_) {}
  } catch (e) {
    if (e && e.blockedVerdict) return rejectBlockedUrl(res, e.blockedVerdict, 'FastMP4');
    console.error('[FastMP4] probe failed:', e.message);
    return res.status(502).send('upstream probe failed');
  }

  const reqRange = parseClientRange(req.headers['range'], total);
  const start = reqRange ? reqRange.start : 0;
  const end = reqRange && reqRange.end != null
    ? reqRange.end
    : (total != null ? total - 1 : null);

  const isPartial = !!reqRange;
  const contentLength = end != null ? (end - start + 1) : null;

  res.status(isPartial ? 206 : 200);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  if (contentLength != null) res.setHeader('Content-Length', String(contentLength));
  if (isPartial && total != null) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);

  if (req.method === 'HEAD') return res.end();

  // Ordered parallel fetch.
  const ac = new AbortController();
  req.on('close', () => { try { ac.abort(); } catch (_) {} });

  const pending = new Map(); // seq -> Promise<Buffer>
  let nextOffset = start;
  let nextSeq = 0;
  let exhausted = false;

  // Attach a no-op catch to every queued promise the moment it is created, so an
  // abort cannot produce an unhandledRejection before/after we await it.
  const track = (p) => { p.catch(() => {}); return p; };

  const launch = () => {
    if (exhausted) return;
    if (end != null && nextOffset > end) { exhausted = true; return; }
    const s = nextOffset;
    const e = end != null ? Math.min(s + chunkSize - 1, end) : (s + chunkSize - 1);
    nextOffset = e + 1;
    const seq = nextSeq++;
    pending.set(seq, track(fetchRangeBuf(targetUrl, s, e, upstreamHeaders, ac.signal)));
  };

  let aborted = false;
  res.on('close', () => { aborted = true; try { ac.abort(); } catch (_) {} });

  try {
    for (let i = 0; i < concurrency; i++) launch();
    let serve = 0;
    while (pending.has(serve)) {
      let buf;
      try {
        buf = await pending.get(serve);
      } catch (e) {
        pending.delete(serve);
        if (aborted || (e && e.__expected)) return; // client went away; normal
        console.error('[FastMP4] chunk failed:', e.message);
        break; // stop; headers already sent
      }
      pending.delete(serve);
      if (aborted) return;
      if (buf && buf.length) {
        if (!res.write(buf)) {
          await new Promise(r => res.once('drain', r));
        }
      }
      // a short read means upstream had nothing more for this window
      if (!buf || buf.length < chunkSize) {
        if (end == null) exhausted = true;
      }
      serve++;
      launch();
    }
    res.end();
  } catch (e) {
    if (aborted || (e && e.__expected)) return;
    console.error('[FastMP4] error:', e.message);
    if (!res.headersSent) res.status(502).send('Proxy error');
    else res.end();
  }
});

// ─── /api/mp4proxy — single-connection MP4 passthrough (kept for compatibility)
router.get('/api/mp4proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://ok.ru/';
  if (!targetUrl) return res.status(400).send('Missing url');

  // SSRF gate — must run before the upstream fetch below.
  const verdict = await checkOutboundUrl(targetUrl);
  if (!verdict.ok) return rejectBlockedUrl(res, verdict, 'MP4Proxy');

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': referer,
      'Origin': 'https://ok.ru',
      'Accept': '*/*',
    };
    if (req.headers['range']) {
      headers['Range'] = req.headers['range'];
    }

    // Tie the upstream request to the client: when the player goes away before
    // the body is done, abort the fetch instead of leaving the upstream socket
    // open until undici's body timeout (300 s).
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });

    const upstream = await fetchFollowingCheckedRedirects(targetUrl, { headers, signal: ac.signal });

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    if (upstream.headers.get('content-type')) res.setHeader('Content-Type', upstream.headers.get('content-type'));
    if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
    if (upstream.headers.get('content-range')) res.setHeader('Content-Range', upstream.headers.get('content-range'));

    if (upstream.body) {
      // pipeline() (unlike .pipe()) handles errors on both ends: an upstream
      // reset mid-body destroys the response, so the player sees a broken
      // transfer instead of a hung one, and a client disconnect cancels the
      // upstream body. Without it the reset was an unhandled 'error' event.
      pipeline(Readable.fromWeb(upstream.body), res, (err) => {
        if (err && !ac.signal.aborted) console.warn('[MP4Proxy] Stream ended early:', err.message);
      });
    } else {
      res.end();
    }
  } catch (e) {
    if (res.destroyed || (e && e.name === 'AbortError')) return; // client went away
    if (e && e.blockedVerdict) return rejectBlockedUrl(res, e.blockedVerdict, 'MP4Proxy');
    console.error('[MP4Proxy] Error:', e.message);
    if (!res.headersSent) res.status(e && e.statusCode === 502 ? 502 : 500).send('Proxy error');
  }
});

function createSegmentUncloakStream() {
  const { Transform } = require('stream');
  let buffered = Buffer.alloc(0);
  let stripping = true;

  return new Transform({
    transform(chunk, encoding, callback) {
      if (!stripping) {
        this.push(chunk);
        return callback();
      }

      buffered = Buffer.concat([buffered, chunk]);

      // Direct clean TS packet
      if (buffered.length >= 4 && buffered[0] === 0x47) {
        stripping = false;
        this.push(buffered);
        return callback();
      }

      // PNG cloaked TS (WatchFooty / sportsembed) - starts with \x89PNG
      if (buffered.length >= 4 && buffered[0] === 0x89 && buffered[1] === 0x50 && buffered[2] === 0x4e && buffered[3] === 0x47) {
        const iend = buffered.indexOf(Buffer.from('IEND'));
        if (iend >= 0 && iend + 8 <= buffered.length) {
          stripping = false;
          this.push(buffered.subarray(iend + 8));
          return callback();
        }
        return callback();
      }

      // RIFF / WEBP cloaked TS (Streamed.pk / TikTok CDN)
      if (buffered.length >= 12 && buffered[0] === 0x52 && buffered[1] === 0x49 && buffered[2] === 0x46 && buffered[3] === 0x46) {
        const exif = buffered.indexOf(Buffer.from('EXIF'));
        if (exif >= 0 && exif + 8 <= buffered.length) {
          stripping = false;
          this.push(buffered.subarray(exif + 8));
          return callback();
        }
        if (buffered.length >= 43 && buffered[42] === 0x47) {
          stripping = false;
          this.push(buffered.subarray(42));
          return callback();
        }
        return callback();
      }

      // General scan for TS 188-byte sync byte pattern (verify at least 2 consecutive sync points)
      for (let i = 0; i < Math.min(buffered.length, 65536); i++) {
        if (buffered[i] === 0x47 && i + 188 < buffered.length && buffered[i + 188] === 0x47) {
          if (i + 376 >= buffered.length || buffered[i + 376] === 0x47) {
            stripping = false;
            this.push(buffered.subarray(i));
            return callback();
          }
        }
      }

      // If more than 128KB collected without sync byte, pass through as-is
      if (buffered.length > 131072) {
        stripping = false;
        this.push(buffered);
        return callback();
      }

      callback();
    },
    flush(callback) {
      if (stripping && buffered.length > 0) {
        this.push(buffered);
      }
      callback();
    }
  });
}

router.get('/api/hlschunk', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer;
  const origin = req.query.origin;
  if (!targetUrl) return res.status(400).send('Missing url');

  // SSRF gate — must run before client.get() below. Marked async only for this
  // await; the streaming path itself is untouched.
  const verdict = await checkOutboundUrl(targetUrl);
  if (!verdict.ok) return rejectBlockedUrl(res, verdict, 'HLSChunk');

  try {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? hlsChunkHttpsAgent : hlsChunkHttpAgent;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };
    if (referer) headers['Referer'] = referer;
    if (origin) headers['Origin'] = origin;
    if (req.headers['range']) headers['Range'] = req.headers['range'];

    let clientGone = false;
    const upstreamReq = client.get(targetUrl, {
      agent,
      headers,
      timeout: 15000
    }, upstreamRes => {
      res.status(upstreamRes.statusCode);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'video/mp2t');

      // pipeline() propagates an upstream reset to the response (destroyed,
      // not left hanging) and never leaves an 'error' event unhandled.
      pipeline(upstreamRes, createSegmentUncloakStream(), res, (err) => {
        if (!err) return;
        if (!res.writableFinished && !upstreamReq.destroyed) upstreamReq.destroy();
        if (!clientGone) console.warn('[HLSChunk] Stream ended early:', err.message);
      });
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Upstream timeout'));
    });

    upstreamReq.on('error', err => {
      console.error('[HLSChunk] Upstream request error:', err.message);
      if (!res.headersSent) res.status(502).send('Upstream error');
    });

    // Client went away before the segment was fully sent: drop the upstream
    // request too. Keyed on the response (not req 'close') and skipped once
    // the response has finished, so a completed keep-alive socket is reused.
    res.on('close', () => {
      if (res.writableFinished) return;
      clientGone = true;
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });
  } catch (e) {
    console.error('[HLSChunk] Error:', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error');
  }
});


router.fetchRangeBuf = fetchRangeBuf;
module.exports = router;
router.fetchFollowingCheckedRedirects = fetchFollowingCheckedRedirects;
