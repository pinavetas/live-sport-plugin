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
    const defaultFetch = typeof globalThis.fetch === 'function'
      ? (url, options) => globalThis.fetch(url, options)
      : (url, options) => this.proxyFetch(url, options);

    this.resolver = new MadPlayResolver({
      baseUrl,
      fetchFn: defaultFetch
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
