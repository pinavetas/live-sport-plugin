'use strict';

const { safeFetch } = require('../impitClient');

const MAX_CACHE_SIZE = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for immutable chunk lengths
const DEFAULT_FALLBACK_LENGTH = 1022720; // 5440 * 188 bytes (MPEG-TS packet aligned)
const DEFAULT_BITRATE = 6000000; // 6 Mbps default for 1080p
const CLOAKED_PREFIX_BYTES = 42; // fake WebP/RIFF header Streamed.pk / TikTok CDN prepends

// Use 1.0 exact safety factor. Pre-probing ensures the exact segment length
// is known and cached before serving the manifest, matching upstream TikTok CDN
// byte counts to avoid player decoder EOF stalls and repeated frames.
const ESTIMATE_SAFETY_FACTOR = 1.0;

// After a failed probe, suppress re-probing for this long so the ~2-4s playlist
// rewrite cadence does not fire a new probe for the same URL every cycle.
const PROBE_RETRY_MS = 10 * 1000;
const MAX_FAILURE_ENTRIES = 5000;

class SegmentLengthService {
  constructor(opts = {}) {
    this.maxSize = opts.maxSize || MAX_CACHE_SIZE;
    this.autoProbe = opts.autoProbe !== false;
    this.maxConcurrentProbes = Number.isSafeInteger(opts.maxConcurrentProbes) && opts.maxConcurrentProbes > 0
      ? opts.maxConcurrentProbes
      : 4;
    this.activeProbes = 0;
    this.cache = new Map(); // url -> { length, expiresAt }
    this.inFlightProbes = new Map(); // url -> Promise<number|null>
    this.probeFailures = new Map(); // url -> timestamp of last failed probe
  }

  /**
   * Align byte count to MPEG-TS packet boundary (188 bytes).
   *
   * @param {number} rawBytes
   * @returns {number}
   */
  alignToTsPacket(rawBytes) {
    if (rawBytes <= 188) return 188;
    return Math.floor(rawBytes / 188) * 188;
  }

  /**
   * Check if a segment URL has a valid probed length in cache.
   *
   * @param {string} segmentUrl
   * @returns {boolean}
   */
  hasValidLength(segmentUrl) {
    const cached = this.cache.get(segmentUrl);
    return Boolean(cached && cached.expiresAt > Date.now() && cached.length > 0);
  }

  /**
   * Get cached segment length or compute a fast over-declared fallback while
   * probing in the background. Only a PROBED length is ever cached — estimates
   * are recomputed per call so a failed probe retries on the next playlist
   * cycle instead of poisoning the cache with a wrong length.
   *
   * @param {string} segmentUrl Upstream segment URL
   * @param {Object} [opts={}]
   * @param {number} [opts.duration] Segment duration in seconds (from #EXTINF)
   * @param {number} [opts.bitrate] Stream bitrate in bps (from #EXT-X-STREAM-INF)
   * @param {string} [opts.referer]
   * @param {string} [opts.origin]
   * @returns {number} Segment byte length (excluding the 42 fake prefix bytes)
   */
  getSegmentLength(segmentUrl, opts = {}) {
    const cached = this.cache.get(segmentUrl);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.length;
    }

    // Trigger non-blocking background probe — unless one just failed for this
    // URL (avoid probe-spamming a URL that will not answer every rewrite).
    const failedAt = this.probeFailures.get(segmentUrl) || 0;
    if (this.autoProbe && now - failedAt > PROBE_RETRY_MS) {
      this.probeContentLength(segmentUrl, opts).catch(() => {});
    }

    return this.estimateLength(opts);
  }

  /**
   * Over-declared length estimate used until a probe lands.
   *
   * @param {Object} [opts={}]
   * @returns {number}
   */
  estimateLength(opts = {}) {
    let estimatedTotal;
    if (opts.duration && opts.duration > 0) {
      const bitrate = opts.bitrate || DEFAULT_BITRATE;
      estimatedTotal = Math.round((opts.duration * bitrate * ESTIMATE_SAFETY_FACTOR) / 8);
    } else {
      estimatedTotal = Math.round(DEFAULT_FALLBACK_LENGTH * ESTIMATE_SAFETY_FACTOR);
    }
    const videoBytes = Math.max(188, estimatedTotal - CLOAKED_PREFIX_BYTES);
    return this.alignToTsPacket(videoBytes);
  }

  /**
   * Probe upstream Content-Length. Signed CDN objects (TikTok .image etc.)
   * refuse HEAD but serve ranged GETs, so "Range: bytes=0-0" is tried first:
   * it returns 1 byte plus "Content-Range: bytes 0-0/<total>" carrying the
   * true object size. HEAD is kept as a fallback for CDNs that allow it.
   *
   * Resolves with the probed byte length (excluding the 42-byte prefix), or
   * null when the probe failed. Caches only real probed lengths.
   *
   * @param {string} segmentUrl
   * @param {Object} [opts={}]
   * @returns {Promise<number|null>}
   */
  async probeContentLength(segmentUrl, opts = {}) {
    const cached = this.cache.get(segmentUrl);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.length;
    }

    if (this.inFlightProbes.has(segmentUrl)) {
      return this.inFlightProbes.get(segmentUrl);
    }

    // Segment probes are best-effort background work. Do not queue unlimited
    // distinct URLs when concurrent manifests are rewritten; callers can use
    // the existing estimated length and a later playlist cycle can retry.
    if (this.activeProbes >= this.maxConcurrentProbes) {
      return null;
    }
    this.activeProbes++;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': opts.referer || 'https://embed.st/',
      'Origin': opts.origin || 'https://embed.st'
    };

    const probePromise = (async () => {
      try {
        const ranged = await safeFetch(segmentUrl, {
          method: 'GET',
          headers: { ...headers, Range: 'bytes=0-0' },
          timeoutMs: 4000,
          attempts: 1
        });
        const rangedTotal = ranged && ranged.headers ? this._totalLengthFromHeaders(ranged.headers) : 0;
        if (rangedTotal > CLOAKED_PREFIX_BYTES) {
          const videoBytes = rangedTotal - CLOAKED_PREFIX_BYTES;
          this.setCachedLength(segmentUrl, videoBytes);
          this.probeFailures.delete(segmentUrl);
          return videoBytes;
        }

        // HEAD fallback for CDNs that allow it (Content-Length = full object).
        const head = await safeFetch(segmentUrl, { method: 'HEAD', headers, timeoutMs: 4000, attempts: 1 });
        const headTotal = head && head.headers ? this._totalLengthFromHeaders(head.headers) : 0;
        if (headTotal > CLOAKED_PREFIX_BYTES) {
          const videoBytes = headTotal - CLOAKED_PREFIX_BYTES;
          this.setCachedLength(segmentUrl, videoBytes);
          this.probeFailures.delete(segmentUrl);
          return videoBytes;
        }
      } catch (_) {}

      // Probe failed: cache NOTHING. A cached estimate would be served as
      // truth for the entry's whole TTL and never re-probed — the failure
      // mode that truncates every segment by the estimate's error. Only
      // remember the failure briefly so rewrites within one playlist cycle
      // don't spam probes for the same URL.
      if (this.probeFailures.size >= MAX_FAILURE_ENTRIES) {
        this.probeFailures.clear();
      }
      this.probeFailures.set(segmentUrl, Date.now());
      return null;
    })().finally(() => {
      this.inFlightProbes.delete(segmentUrl);
      this.activeProbes = Math.max(0, this.activeProbes - 1);
    });

    this.inFlightProbes.set(segmentUrl, probePromise);
    return probePromise;
  }

  /**
   * Extract the total object size from Content-Range ("bytes 0-0/<total>") or
   * Content-Length headers. Returns 0 when neither carries a usable size.
   *
   * @param {Object} headers Response-like headers with .get()
   * @returns {number}
   */
  _totalLengthFromHeaders(headers) {
    try {
      const contentRange = headers.get('content-range');
      if (contentRange) {
        const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange);
        if (m) {
          const total = parseInt(m[1], 10);
          if (Number.isFinite(total) && total > 0) return total;
        }
      }
      const cl = headers.get('content-length');
      if (cl) {
        const n = parseInt(cl, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch (_) {}
    return 0;
  }

  setCachedLength(segmentUrl, length, ttlMs = CACHE_TTL_MS) {
    if (this.cache.size >= this.maxSize) {
      // LRU Eviction: remove oldest 20%
      const keysToDelete = [...this.cache.keys()].slice(0, Math.floor(this.maxSize * 0.2));
      for (const k of keysToDelete) {
        this.cache.delete(k);
      }
    }

    this.cache.set(segmentUrl, {
      length,
      expiresAt: Date.now() + ttlMs
    });
  }

  clear() {
    this.cache.clear();
    this.inFlightProbes.clear();
    this.probeFailures.clear();
  }
}

// Export singleton instance and class
const defaultService = new SegmentLengthService();
defaultService.SegmentLengthService = SegmentLengthService;

module.exports = defaultService;
