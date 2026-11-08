'use strict';

/**
 * PuppeteerSnifferService.js
 *
 * Generic headless browser network sniffer service (Tier C fallback).
 * Inspired by FMHYPlay's Sniffer architecture: navigates to arbitrary embed players,
 * actively triggers media playback, and intercepts direct HLS (.m3u8) or DASH (.mpd)
 * stream manifests.
 *
 * Core Guarantees:
 * - Zero Server Bandwidth Bleed: Emits direct CDN stream URLs with behaviorHints.proxyHeaders.
 * - Single-Flight Coalescing: Concurrent requests for the same URL share a single sniffer execution.
 * - Process Isolation: Runs sniffing in an isolated child process so crashes/leaks never impact the core addon.
 * - Graceful Degradation: If Puppeteer or Chromium is not installed, degrades silently without throwing.
 */

const { execFile } = require('child_process');
const path = require('path');
const StreamEntity = require('../domain/StreamEntity');

class PuppeteerSnifferService {
  constructor(opts = {}) {
    let scriptPath = null;
    let execFn = null;
    let defaultTimeoutMs = null;
    let cacheTtlMs = null;
    try {
      if (opts && typeof opts === 'object') {
        if (Object.prototype.hasOwnProperty.call(opts, 'scriptPath')) scriptPath = opts.scriptPath;
        if (Object.prototype.hasOwnProperty.call(opts, 'execFn')) execFn = opts.execFn;
        if (Object.prototype.hasOwnProperty.call(opts, 'defaultTimeoutMs')) defaultTimeoutMs = opts.defaultTimeoutMs;
        if (Object.prototype.hasOwnProperty.call(opts, 'cacheTtlMs')) cacheTtlMs = opts.cacheTtlMs;
      }
    } catch (_) {}

    this.scriptPath = scriptPath || path.join(__dirname, '../providers/run_puppeteer_extractor.js');
    this.execFn = execFn || execFile;
    this.defaultTimeoutMs = defaultTimeoutMs || 15000;
    this.cacheTtlMs = cacheTtlMs || 2 * 60 * 1000; // 2 minutes
    this.enabled = process.env.ENABLE_PUPPETEER !== 'false';

    this.cache = new Map(); // targetUrl -> { result, expiresAt }
    this.singleFlight = new Map(); // targetUrl -> Promise<result>
  }

  isAvailable() {
    if (!this.enabled) return false;
    try {
      if (require.resolve('puppeteer-extra')) return true;
    } catch (_) {}
    try {
      if (require.resolve('puppeteer')) return true;
    } catch (_) {}
    try {
      if (require.resolve('puppeteer-core')) return true;
    } catch (_) {}
    return false;
  }

  async sniff(targetUrl, opts = {}) {
    if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
      return null;
    }

    const referer = opts.referer || 'EMPTY';
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;
    const cacheKey = `${targetUrl}|${referer}`;

    // 1. Cache hit check
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    // 2. Single-flight request coalescing
    if (this.singleFlight.has(cacheKey)) {
      return await this.singleFlight.get(cacheKey);
    }

    const runPromise = (async () => {
      try {
        const result = await new Promise((resolve) => {
          this.execFn(
            process.execPath,
            [this.scriptPath, targetUrl, referer, String(timeoutMs)],
            { timeout: timeoutMs + 3000 },
            (err, stdout, stderr) => {
              const output = (stdout || '') + '\n' + (stderr || '');
              try {
                // Find JSON object in stdout
                const lines = (stdout || '').trim().split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                  const line = lines[i].trim();
                  if (line.startsWith('{') && line.endsWith('}')) {
                    const parsed = JSON.parse(line);
                    if (parsed && (parsed.file || (parsed.success && parsed.file))) {
                      const fileUrl = parsed.file;
                      if (!parsed.type && fileUrl) {
                        parsed.type = fileUrl.includes('.mpd') ? 'dash' : 'hls';
                      }
                      if (!parsed.headers) {
                        parsed.headers = {
                          'Referer': referer !== 'EMPTY' ? referer : targetUrl,
                          'Origin': new URL(targetUrl).origin
                        };
                      }
                      return resolve(parsed);
                    }
                  }
                }
              } catch (_) {}

              // Regex fallback for legacy stdout format: {"file":"..."}
              const m = output.match(/"file":\s*"([^"]+)"/);
              if (m) {
                return resolve({
                  file: m[1],
                  type: m[1].includes('.mpd') ? 'dash' : 'hls',
                  headers: {
                    'Referer': referer !== 'EMPTY' ? referer : targetUrl,
                    'Origin': new URL(targetUrl).origin
                  }
                });
              }

              resolve(null);
            }
          );
        });

        if (result && result.file) {
          this.cache.set(cacheKey, {
            result,
            expiresAt: Date.now() + this.cacheTtlMs
          });
        }

        return result;
      } catch (err) {
        console.warn(`[PuppeteerSniffer] Execution error on ${targetUrl}:`, err.message);
        return null;
      } finally {
        this.singleFlight.delete(cacheKey);
      }
    })();

    this.singleFlight.set(cacheKey, runPromise);
    return await runPromise;
  }

  async resolveStream(targetUrl, opts = {}) {
    const sniffResult = await this.sniff(targetUrl, opts);
    if (!sniffResult || !sniffResult.file) {
      return null;
    }

    const providerName = opts.providerName || 'Sniffer';
    const matchTitle = opts.title || opts.matchTitle || 'Live Event';
    const streamHeaders = sniffResult.headers || {
      'Referer': (opts.referer && opts.referer !== 'EMPTY') ? opts.referer : targetUrl,
      'Origin': new URL(targetUrl).origin
    };

    return new StreamEntity({
      name: providerName,
      title: `${providerName} - [Direct CDN] (${matchTitle})`,
      url: sniffResult.file,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: streamHeaders
        }
      },
      resolution: opts.resolution || 'HD'
    });
  }
}

module.exports = PuppeteerSnifferService;
