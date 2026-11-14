'use strict';

/**
 * Plooplayer local decryptor — runs on the viewer's own device (Android TV via
 * Termux, or any always-on machine at home) and turns a ClearKey DASH channel
 * into plain HLS for Stremio / Nuvio, which cannot decrypt ClearKey themselves.
 *
 *   GET /health
 *   GET /ploo/index.m3u8?d=<token>                 HLS master
 *   GET /ploo/video.m3u8?d=&r= · /ploo/audio.m3u8  media playlists
 *   GET /ploo/init.mp4?d=&k=&r=                    init segment, protection boxes removed
 *   GET /ploo/segment.mp4?d=&k=&r=&n=              decrypted media segment
 *
 * `d` is a PlooDecryptorToken minted by the add-on: manifest URL, kid->key map
 * and request headers. The media goes CDN -> this process -> player, all on the
 * viewer's side; the add-on (Vercel) only ever hands out the URL.
 *
 * Reuses the add-on's proven pieces: DashToHlsService (manifest parsing, live
 * window, playlists), cenc/* (CENC removal) and DashUpstream (SSRF guard).
 * Node core modules only, so the whole thing can be served as one file by
 * GET /plooplayer/decryptor.js and started with `node ploo-decryptor.js`.
 */

const http = require('http');
const DashToHlsService = require('../DashToHlsService');
const engine = require('../cenc');
const { fetchGuarded, toBuffer } = require('../DashUpstream');
const { createMiniXmlParser } = require('./miniXml');
const { decodeDecryptorToken } = require('./PlooDecryptorToken');

const VERSION = '1.0.0';
const DEFAULT_PORT = 8090;
const DEFAULT_HOST = '127.0.0.1';
const ROUTE_PREFIX = '/ploo';
const INIT_MAX_BYTES = 4 * 1024 * 1024;
const SEGMENT_MAX_BYTES = 64 * 1024 * 1024;

class Lru {
  constructor(max, ttlMs) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.ttlMs > 0 && Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { at: Date.now(), value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    const job = queue.shift();
    active += 1;
    job.fn().then(job.resolve, job.reject).finally(() => { active -= 1; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

/** safeFetch-shaped adapter over global fetch: timeout, retries on network errors. */
function createFetcher(fetchImpl) {
  return async function fetcher(url, opts = {}) {
    const attempts = Math.max(1, opts.attempts || 1);
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetchImpl(url, {
          headers: opts.headers || {},
          redirect: 'follow',
          signal: AbortSignal.timeout(opts.timeoutMs || 15000)
        });
        const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
        if (opts.maxBodyBytes && Number.isFinite(declared) && declared > opts.maxBodyBytes) {
          return Object.assign(res, { bodyTruncated: true });
        }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]  WHATWG fetch (default: global fetch)
 * @param {number} [options.maxConcurrent]
 * @param {(msg: string) => void} [options.log]
 * @returns {{ handle: (req, res) => Promise<void>, service: DashToHlsService }}
 */
function createLocalDecryptor(options = {}) {
  const fetcher = createFetcher(options.fetchImpl || globalThis.fetch);
  const log = options.log || ((msg) => console.warn(msg));
  const service = new DashToHlsService({
    fetcher,
    proxyEnabled: true,
    routePrefix: ROUTE_PREFIX,
    xmlParser: createMiniXmlParser({ isArray: (name) => DashToHlsService.ALWAYS_ARRAY_TAGS.has(name) })
  });
  const initCache = new Lru(32, 6 * 3600 * 1000);
  const segmentCache = new Lru(12, 30 * 1000);
  const tracksByRep = new Map();
  const inflight = new Map();
  const limit = createLimiter(options.maxConcurrent || 4);

  const singleFlight = (key, fn) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };

  const keysByKid = (keys) => {
    const out = {};
    const kids = Object.keys(keys);
    for (const kid of kids) out[kid] = Buffer.from(keys[kid], 'hex');
    // A single published key is the only one there is: use it even if the init
    // declares the KID in a layout we could not read.
    if (kids.length === 1) out.__fallback = out[kids[0]];
    return out;
  };

  async function loadInit(token, payload, kind, rep, policy) {
    const repKey = `${payload.mpdUrl}|${kind}|${rep.id}`;
    const cached = initCache.get(rep.initUrl);
    if (cached) {
      tracksByRep.set(repKey, cached.tracks);
      return cached;
    }
    const entry = await singleFlight(`init:${rep.initUrl}`, () => limit(async () => {
      const res = await fetchGuarded(rep.initUrl, {
        policy,
        headers: service._sanitizeUpstreamHeaders(payload.headers),
        timeoutMs: 10000,
        attempts: 2,
        maxBodyBytes: INIT_MAX_BYTES,
        fetcher
      });
      if (!res || !res.ok) throw new Error(`init segment HTTP ${res && res.status}`);
      const uncloaked = engine.uncloakInit(await toBuffer(res), { expectedKid: Object.keys(token.keys) });
      const value = { buf: uncloaked.buf, tracks: uncloaked.tracks };
      initCache.set(rep.initUrl, value);
      return value;
    }));
    tracksByRep.set(repKey, entry.tracks);
    if (tracksByRep.size > 64) tracksByRep.delete(tracksByRep.keys().next().value);
    return entry;
  }

  async function decryptedSegment(token, payload, kind, target) {
    const repKey = `${payload.mpdUrl}|${kind}|${target.rep.id}`;
    const tracks = tracksByRep.get(repKey) || (await loadInit(token, payload, kind, target.rep, target.policy)).tracks;
    const res = await fetchGuarded(target.url, {
      policy: target.policy,
      headers: service._sanitizeUpstreamHeaders(payload.headers),
      timeoutMs: 20000,
      attempts: 2,
      maxBodyBytes: SEGMENT_MAX_BYTES,
      fetcher
    });
    if (!res || !res.ok) throw new Error(`segment HTTP ${res && res.status}`);
    const raw = await toBuffer(res);
    if (!service.isProxied(target.rep)) return raw; // clear track: pass through untouched
    return engine.decryptSegment(raw, { tracks, keysByKid: keysByKid(token.keys) }).buf;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      ...headers
    });
    res.end(body);
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch (_) {
      return send(res, 400, 'Bad request');
    }
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    if (url.pathname === '/health' || url.pathname === '/') {
      return send(res, 200, JSON.stringify({ ok: true, name: 'plooplayer-decryptor', version: VERSION }),
        { 'Content-Type': 'application/json' });
    }
    if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) return send(res, 404, 'Not found');

    const d = url.searchParams.get('d') || '';
    const token = decodeDecryptorToken(d);
    if (!token) return send(res, d ? 403 : 400, d ? 'Invalid d parameter' : 'Missing d parameter');
    const payload = { mpdUrl: token.mpdUrl, headers: token.headers };
    const route = url.pathname.slice(ROUTE_PREFIX.length + 1);
    const repId = url.searchParams.get('r') || undefined;
    const kind = url.searchParams.get('k') === 'audio' || route === 'audio.m3u8' ? 'audio' : 'video';
    const reqBase = `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`;

    try {
      if (route === 'index.m3u8' || route === 'video.m3u8' || route === 'audio.m3u8') {
        const body = route === 'index.m3u8'
          ? await service.buildMaster(payload, d, reqBase)
          : await service.buildMediaPlaylist(payload, kind, d, reqBase, repId);
        return send(res, 200, body, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store'
        });
      }
      if (route === 'init.mp4') {
        const { rep, policy } = await service.resolveRepresentation(payload, kind, repId);
        if (!rep.initUrl) return send(res, 404, 'Representation has no initialization segment');
        const entry = await loadInit(token, payload, kind, rep, policy);
        return send(res, 200, entry.buf, { 'Content-Type': 'video/mp4', 'Content-Length': String(entry.buf.length) });
      }
      if (route === 'segment.mp4') {
        const number = Number(url.searchParams.get('n'));
        if (!Number.isInteger(number)) return send(res, 400, 'Invalid n parameter');
        const target = await service.resolveSegment(payload, kind, repId, number);
        const cacheKey = `${payload.mpdUrl}|${kind}|${target.rep.id}|${number}`;
        let buf = segmentCache.get(cacheKey);
        if (!buf) {
          buf = await singleFlight(cacheKey, () => limit(() => decryptedSegment(token, payload, kind, target)));
          segmentCache.set(cacheKey, buf);
        }
        return send(res, 200, buf, { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length) });
      }
      return send(res, 404, 'Not found');
    } catch (err) {
      log(`[ploo-decryptor] ${route} failed (${(err && err.code) || 'ERROR'}): ${err && err.message}`);
      return send(res, /^SSRF_/.test(String(err && err.code)) ? 403 : 502, 'Upstream or decryption failure');
    }
  }

  return { handle, service };
}

/** Starts the HTTP server. PORT / HOST env vars override the defaults. */
function main(env = process.env) {
  const parsedPort = parseInt(env.PORT, 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_PORT; // 0 = any free port
  const host = env.HOST || DEFAULT_HOST;
  const { handle } = createLocalDecryptor();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('error', (err) => {
    console.error(err && err.code === 'EADDRINUSE'
      ? `[ploo-decryptor] port ${port} is already in use (is it already running?)`
      : `[ploo-decryptor] ${err && err.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const actual = server.address().port;
    console.log(`[ploo-decryptor] v${VERSION} listening on http://${host}:${actual}`);
    console.log(`[ploo-decryptor] put http://${host === '0.0.0.0' ? '<this-device-ip>' : host}:${actual} in the add-on's /configure page`);
  });
  return server;
}

module.exports = { createLocalDecryptor, main, VERSION, ROUTE_PREFIX, DEFAULT_PORT };
