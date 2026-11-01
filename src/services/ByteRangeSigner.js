'use strict';

const crypto = require('crypto');

const DEFAULT_SECRET = process.env.APP_SECRET || process.env.SESSION_SECRET || 'nuvio-tiktok-byterange-secret-v1';
const DEFAULT_TTL_MS = 120 * 1000; // 120 seconds sliding TTL

/**
 * ByteRangeSigner
 *
 * Stateless URL-safe Base64 token generation and HMAC-SHA256 verification
 * for HLS zero-bandwidth 307 redirects.
 */
class ByteRangeSigner {
  constructor(secret = DEFAULT_SECRET) {
    this.secret = secret;
  }

  /**
   * Encode segment data into a URL-safe Base64 token and HMAC signature.
   *
   * @param {Object} data
   * @param {string} data.url Target CDN URL
   * @param {string} [data.referer]
   * @param {string} [data.origin]
   * @param {number} [data.prefixBytes=42]
   * @param {number} [ttlMs=120000]
   * @returns {{ token: string, psig: string }}
   */
  encodeSegmentToken(data, ttlMs = DEFAULT_TTL_MS) {
    const exp = Math.floor((Date.now() + ttlMs) / 1000);
    const payloadObj = {
      u: data.url,
      r: data.referer || '',
      o: data.origin || '',
      p: data.prefixBytes !== undefined ? data.prefixBytes : 42,
      e: exp
    };

    const token = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(`${token}.${exp}`)
      .digest('base64url');

    return {
      token,
      psig: `${exp}.${signature}`
    };
  }

  /**
   * Verify and decode a token + psig.
   *
   * @param {string} token URL-safe Base64 token
   * @param {string} psig Timestamp and HMAC signature (format: "<exp>.<signature>")
   * @returns {Object|null} Decoded payload or null if invalid/expired
   */
  verifySegmentToken(token, psig) {
    if (!token || !psig || typeof token !== 'string' || typeof psig !== 'string') {
      return null;
    }

    const dotIndex = psig.indexOf('.');
    if (dotIndex === -1) return null;

    const expStr = psig.slice(0, dotIndex);
    const signature = psig.slice(dotIndex + 1);
    const exp = parseInt(expStr, 10);

    if (isNaN(exp)) return null;

    // Check expiration
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > exp) {
      return null;
    }

    // Recompute signature
    const expectedSignature = crypto
      .createHmac('sha256', this.secret)
      .update(`${token}.${expStr}`)
      .digest('base64url');

    // Timing-safe comparison
    try {
      const sigBuf = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expectedSignature, 'utf8');
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
      }
    } catch (_) {
      return null;
    }

    // Decode payload
    try {
      const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
      const payload = JSON.parse(jsonStr);
      if (!payload || !payload.u) return null;

      return {
        url: payload.u,
        referer: payload.r,
        origin: payload.o,
        prefixBytes: payload.p,
        exp: payload.e
      };
    } catch (_) {
      return null;
    }
  }
}

// Export singleton instance and class
const defaultSigner = new ByteRangeSigner();
defaultSigner.ByteRangeSigner = ByteRangeSigner;

module.exports = defaultSigner;
