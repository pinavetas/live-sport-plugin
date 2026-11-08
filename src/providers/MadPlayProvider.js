'use strict';

/**
 * MadPlayProvider.js
 *
 * Dedicated live sports provider for MadPlay / RBTV+ network.
 * Features:
 * - Dynamic and configurable domain / host (from config or process.env.MADPLAY_BASE_URL)
 * - Protobuf parsing with O(1) hash map stream indexing
 * - Direct upstream CDN playback with proxyHeaders (Zero Server Bandwidth Bleed)
 * - Lightweight manifest proxy option (/api/manifest) and external web player fallback
 */

const BaseProvider = require('./BaseProvider');
const { BASE_URL } = require('../config');
const { MadPlayResolver, DEFAULT_BASE_URL } = require('../resolver/madplay/MadPlayResolver');
const { safeFetch } = require('../impitClient');

class MadPlayProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'MadPlay';
    this.source = 'madplay';

    let customUrl = null;
    try {
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'madplayUrl')) {
        customUrl = opts.madplayUrl;
      }
    } catch (_) {}

    const baseUrl = customUrl || process.env.MADPLAY_BASE_URL || DEFAULT_BASE_URL;

    // safeFetch honours the resolver's `timeoutMs` (native fetch silently
    // ignores it, so a stalled upstream could hang a request for minutes) and
    // goes through impit's browser TLS fingerprint with an undici fallback.
    // Its response exposes ok/status/headers/text()/arrayBuffer(), which is all
    // the resolver reads (headers may be a Headers object or a plain object).
    this.resolver = new MadPlayResolver({
      baseUrl,
      fetchFn: (url, options) => safeFetch(url, options)
    });

    if (this.circuitBreaker) {
      this.fetchMatchesWrapped = this.circuitBreaker.wrap(`${this.name}_getMatches`, async () => {
        return await this.resolver.getMatches();
      });
    }
  }

  setBaseUrl(url) {
    if (this.resolver) {
      this.resolver.setBaseUrl(url);
    }
  }

  getBaseUrl() {
    return this.resolver ? this.resolver.getBaseUrl() : DEFAULT_BASE_URL;
  }

  async getMatches() {
    try {
      if (this.fetchMatchesWrapped) {
        return await this.fetchMatchesWrapped.fire();
      }
      return await this.resolver.getMatches();
    } catch (err) {
      console.error(`[${this.name}] Failed to fetch matches:`, err.message);
      return [];
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}, config = {}) {
    try {
      return await this.resolver.resolveStream(sourceId, matchCategory, matchTitle, src, config, BASE_URL);
    } catch (err) {
      console.error(`[${this.name}] Failed to resolve stream for ${sourceId}:`, err.message);
      return [];
    }
  }
}

module.exports = MadPlayProvider;
