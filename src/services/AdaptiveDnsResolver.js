/**
 * AdaptiveDnsResolver.js - Dynamic, self-healing DNS resolution and anti-censorship circuit breaker.
 *
 * WHY THIS EXISTS
 * ---------------
 * In several jurisdictions (e.g. Spain, Italy, UK), local ISPs enforce streaming site
 * blocks using DNS Sinkholing (returning 127.0.0.1, 0.0.0.0, or NXDOMAIN for legitimate
 * public domains like dlive.sx or fullraces.com). When Node connects to 127.0.0.1:443,
 * it immediately fails with `ECONNREFUSED 127.0.0.1:443`.
 *
 * HOW THIS WORKS (Adaptive Circuit Breaker)
 * -----------------------------------------
 * 1. Zero overhead happy-path: System DNS (node:dns lookup) is queried first.
 *    Localhost, local subnets (.local, .internal), and standard public domains work
 *    normally with zero network overhead.
 * 2. Automated Sinkhole Detection:
 *    If a public domain resolves to a loopback/unspecified IP (127.0.0.0/8, 0.0.0.0, ::1)
 *    or returns ENOTFOUND/EAI_AGAIN, the resolver detects the poisoning attempt.
 * 3. Secure Fallback & Circuit Breaker:
 *    - Immediately re-resolves via trusted uncensored resolvers (1.1.1.1, 8.8.8.8) with
 *      secondary DoH (DNS-over-HTTPS) fallback if UDP port 53 is intercepted.
 *    - Trips the Circuit Breaker for that hostname to 'OPEN' state for 30 minutes.
 *    - While OPEN, future requests for that host bypass the broken system DNS entirely,
 *      eliminating failed connection attempts and latency.
 *    - After TTL, transitions to 'HALF-OPEN' to re-probe system DNS (self-healing if VPN
 *      is connected or ISP block is removed).
 */

'use strict';

const dns = require('node:dns');

class AdaptiveDnsResolver {
  constructor(options = {}) {
    this.primaryDnsServers = options.servers || [
      '1.1.1.1',
      '8.8.8.8',
      '1.0.0.1',
      '8.8.4.4',
      '9.9.9.9'
    ];

    this.circuitResetMs = options.circuitResetMs || 30 * 60 * 1000; // 30 minutes
    this.cacheTtlMs = options.cacheTtlMs || 5 * 60 * 1000;         // 5 minutes
    // A genuinely dead domain (secure DNS + DoH both fail) is remembered for this
    // long so every request to it does not pay the full secure-resolve + DoH cost.
    this.negativeCacheTtlMs = options.negativeCacheTtlMs ?? 60 * 1000;
    this.maxEntries = options.maxEntries || 1000;

    // DoH endpoint addressed by IP: resolving a DoH *hostname* would itself go
    // through the global dispatcher -> this resolver (recursion if it is sinkholed).
    this.dohUrl = options.dohUrl || 'https://1.1.1.1/dns-query';
    this.dohTimeoutMs = options.dohTimeoutMs || 3500;
    this.fetchFn = options.fetchFn || ((url, init) => globalThis.fetch(url, init));

    // host -> { state: 'OPEN', trippedAt: number, reason: string, ips: string[], cachedAt: number }
    this.poisonedHosts = new Map();
    // host -> { ips: string[], expiresAt: number }
    this.dnsCache = new Map();
    // host -> expiresAt (secure resolution failed: domain considered dead)
    this.negativeCache = new Map();
    // host -> Promise<string[]> (concurrent resolveSecure calls share one query)
    this.inFlight = new Map();

    // Without timeout/tries, c-ares retries every server with its default
    // timeouts, so with UDP 53 blocked the DoH fallback is reached only after
    // a long stall. Fail fast per server and let DoH take over.
    this.resolver = options.resolver || new dns.promises.Resolver({
      timeout: options.resolverTimeoutMs ?? 1500,
      tries: options.resolverTries ?? 1,
    });
    if (!options.resolver) this.resolver.setServers(this.primaryDnsServers);

    // Bind lookup method for use as drop-in replacement for dns.lookup
    this.lookup = this.lookup.bind(this);
  }

  /**
   * Identifies if a hostname is local or already an IP literal.
   */
  isLocalOrReserved(hostname) {
    if (!hostname || typeof hostname !== 'string') return true;
    const h = hostname.toLowerCase().trim();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.test')) {
      return true;
    }
    // IPv4 literal: 1.2.3.4
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    // IPv6 literal: [::1] or fe80::...
    if (h.includes(':')) return true;
    return false;
  }

  /**
   * Checks if an IP address belongs to standard DNS sinkhole ranges.
   */
  isSinkholedIp(ip) {
    if (!ip || typeof ip !== 'string') return false;
    const clean = ip.trim();
    return clean.startsWith('127.') || clean === '0.0.0.0' || clean === '::1' || clean === '::';
  }

  /**
   * Checks whether the circuit breaker is currently OPEN for this host.
   */
  isPoisonedHost(hostname) {
    if (!hostname || this.isLocalOrReserved(hostname)) return false;
    const hostKey = hostname.toLowerCase().trim();
    const entry = this.poisonedHosts.get(hostKey);
    if (!entry) return false;

    if (Date.now() - entry.trippedAt > this.circuitResetMs) {
      // Transition to HALF-OPEN: allow a fresh system check
      this.poisonedHosts.delete(hostKey);
      return false;
    }

    return true;
  }

  /**
   * Trip the circuit breaker for a host explicitly (e.g. from connection refused on 127.0.0.1).
   */
  markPoisoned(hostname, reason = 'sinkholed') {
    if (this.isLocalOrReserved(hostname)) return;
    const hostKey = hostname.toLowerCase().trim();
    if (this.poisonedHosts.size >= this.maxEntries) {
      const oldest = this.poisonedHosts.keys().next().value;
      if (oldest) this.poisonedHosts.delete(oldest);
    }
    this.poisonedHosts.set(hostKey, {
      state: 'OPEN',
      trippedAt: Date.now(),
      reason: String(reason)
    });
  }

  /**
   * Keeps only usable public IPv4 answers: a secure resolver that also returns a
   * sinkhole address (127.x, 0.0.0.0) has not produced a route around the block.
   */
  _filterSecureIps(ips) {
    if (!Array.isArray(ips)) return [];
    return ips.filter(ip => typeof ip === 'string'
      && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)
      && !this.isSinkholedIp(ip));
  }

  /**
   * Resolves a hostname using uncensored public DNS, with fallback to DoH.
   * Concurrent calls for the same host share one query; failures are cached
   * for negativeCacheTtlMs.
   */
  async resolveSecure(hostname) {
    const hostKey = hostname.toLowerCase().trim();
    const cached = this.dnsCache.get(hostKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ips;
    }

    const deadUntil = this.negativeCache.get(hostKey);
    if (deadUntil !== undefined) {
      if (Date.now() < deadUntil) {
        throw new Error(`AdaptiveDnsResolver: failed to resolve ${hostKey} via secure DNS (cached)`);
      }
      this.negativeCache.delete(hostKey);
    }

    const pending = this.inFlight.get(hostKey);
    if (pending) return pending;

    const attempt = this._resolveSecureUncached(hostKey)
      .then((ips) => {
        this._cacheResolved(hostKey, ips);
        return ips;
      }, (err) => {
        this._cacheNegative(hostKey);
        throw err;
      })
      .finally(() => {
        this.inFlight.delete(hostKey);
      });
    this.inFlight.set(hostKey, attempt);
    return attempt;
  }

  async _resolveSecureUncached(hostKey) {
    // Step 1: Direct UDP/TCP query via secure resolver (1.1.1.1, 8.8.8.8)
    try {
      const ips = this._filterSecureIps(await this.resolver.resolve4(hostKey));
      if (ips.length > 0) return ips;
    } catch (_) {
      // fall through to DoH
    }

    // Step 2: DoH (DNS-over-HTTPS) in case UDP port 53 is blocked/intercepted,
    // or the resolver answered only with sinkhole addresses.
    try {
      const dohUrl = `${this.dohUrl}?name=${encodeURIComponent(hostKey)}&type=A`;
      const res = await this.fetchFn(dohUrl, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(this.dohTimeoutMs)
      });
      if (res && res.ok) {
        const data = await res.json();
        const dohIps = this._filterSecureIps((data.Answer || [])
          .filter(ans => ans.type === 1 && typeof ans.data === 'string')
          .map(ans => ans.data));
        if (dohIps.length > 0) return dohIps;
      }
    } catch (_) {
      // DoH also failed
    }

    throw new Error(`AdaptiveDnsResolver: failed to resolve ${hostKey} via secure DNS`);
  }

  _cacheNegative(hostKey) {
    if (!(this.negativeCacheTtlMs > 0)) return;
    if (this.negativeCache.size >= this.maxEntries) {
      const oldest = this.negativeCache.keys().next().value;
      if (oldest) this.negativeCache.delete(oldest);
    }
    this.negativeCache.set(hostKey, Date.now() + this.negativeCacheTtlMs);
  }

  /**
   * Decides whether an impit (OS getaddrinfo) connection failure is evidence of
   * DNS sinkholing rather than a genuinely dead domain. Returns true only when:
   *  - the error shows a connection to a sinkhole address (127.x / 0.0.0.0), or
   *  - the system resolver currently returns a sinkhole address, or
   *  - the system resolver says NXDOMAIN but secure DNS resolves the host
   *    (NXDOMAIN-style blocking).
   */
  async confirmSinkhole(hostname, errMessage = '') {
    if (!hostname || this.isLocalOrReserved(hostname)) return false;
    const hostKey = hostname.toLowerCase().trim();
    if (/(^|[^\d.])(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)(?![\d.])/.test(String(errMessage))) {
      return true;
    }

    let records = null;
    let lookupErr = null;
    try {
      records = await new Promise((resolve, reject) => {
        dns.lookup(hostKey, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
      });
    } catch (err) {
      lookupErr = err;
    }

    if (Array.isArray(records)) {
      return records.some(r => r && this.isSinkholedIp(r.address));
    }
    if (lookupErr && (lookupErr.code === 'ENOTFOUND' || lookupErr.code === 'EAI_AGAIN')) {
      try {
        const ips = await this.resolveSecure(hostKey);
        return ips.length > 0;
      } catch (_) {
        return false; // dead everywhere: not censorship
      }
    }
    return false;
  }

  _cacheResolved(hostKey, ips) {
    if (this.dnsCache.size >= this.maxEntries) {
      const oldest = this.dnsCache.keys().next().value;
      if (oldest) this.dnsCache.delete(oldest);
    }
    this.dnsCache.set(hostKey, {
      ips,
      expiresAt: Date.now() + this.cacheTtlMs
    });
  }

  /**
   * Drop-in replacement for dns.lookup(hostname, [options], callback)
   */
  lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    // Pass-through for local, subnets, and raw IP literals
    if (this.isLocalOrReserved(hostname)) {
      return dns.lookup(hostname, options, callback);
    }

    const hostKey = hostname.toLowerCase().trim();
    // Secure resolution only produces IPv4 (A records). A caller that asked for
    // IPv6 must not be handed an IPv4 address labelled as its answer, so it
    // keeps the system result instead.
    const wantsV6Only = Boolean(options) && (options.family === 6 || options.family === 'IPv6');

    // Fast-path: Circuit breaker is OPEN (known poisoned host)
    if (this.isPoisonedHost(hostKey) && !wantsV6Only) {
      this.resolveSecure(hostKey)
        .then(ips => {
          if (options && options.all) {
            callback(null, ips.map(ip => ({ address: ip, family: 4 })));
          } else {
            callback(null, ips[0], 4);
          }
        })
        .catch(() => {
          // If secure resolution failed, fallback to system lookup as last resort
          dns.lookup(hostname, options, callback);
        });
      return;
    }

    // Standard path: Probe system DNS first
    dns.lookup(hostname, options, async (err, address, family) => {
      let isSinkholed = false;
      let badDetail = null;

      if (!err) {
        if (Array.isArray(address)) {
          isSinkholed = address.some(record => this.isSinkholedIp(record.address));
          badDetail = address.map(r => r.address).join(', ');
        } else if (this.isSinkholedIp(address)) {
          isSinkholed = true;
          badDetail = address;
        }
      }

      // Check if system DNS poisoned the response or threw NXDOMAIN
      const isDnsFailure = err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED');
      const shouldFallback = (isSinkholed || isDnsFailure) && !wantsV6Only;

      if (shouldFallback) {
        try {
          const ips = await this.resolveSecure(hostKey);
          if (ips && ips.length > 0) {
            this.markPoisoned(hostKey, badDetail || err?.code || 'sinkholed');
            console.log(`[AdaptiveDNS] 🛡️ DNS sinkhole/failure detected for "${hostKey}" (${badDetail || err?.code}). Dynamically routed through secure DNS -> ${ips.join(', ')}`);
            if (options && options.all) {
              return callback(null, ips.map(ip => ({ address: ip, family: 4 })));
            }
            return callback(null, ips[0], 4);
          }
        } catch (_) {
          // Both system and secure resolution failed, return original error/result
        }
      }

      return callback(err, address, family);
    });
  }
}

// Global Singleton
const adaptiveDnsResolver = new AdaptiveDnsResolver();

module.exports = adaptiveDnsResolver;
module.exports.AdaptiveDnsResolver = AdaptiveDnsResolver;
