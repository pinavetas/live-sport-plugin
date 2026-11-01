'use strict';

/**
 * MadPlayCrypto.js
 *
 * Cryptographic helpers for MadPlay / RBTV+ protocol:
 * - ROT47 cipher decoding for stream URLs
 * - Handshake signature extraction and ordered MD5 prefix computation
 * - AES-256-CBC token encryption for upstream CDN playback tokens
 * - External web player URL generation
 */

const crypto = require('crypto');

// MadPlay AES-256-CBC token key and IV (from client bundle)
// Key: atob('YTc5ODFjYzllYjJmNGQxOWRjZmVhNTdiMTAxZWNkODk=') -> 'a7981cc9eb2f4d19dcfea57b101ecd89'
// IV:  atob('ODAxN2QzYThmMTQwMGQyZg==') -> '8017d3a8f1400d2f'
const AES_KEY = Buffer.from('a7981cc9eb2f4d19dcfea57b101ecd89', 'utf8');
const AES_IV = Buffer.from('8017d3a8f1400d2f', 'utf8');

// Strict order required by MadPlay's signature verification algorithm
const MD5_PARAM_ORDER = ['matchId', 'leagueId', 'seasonId', 'sportType', 'language', 'stream'];

/**
 * In-place ROT47 string transformation
 */
function rot47(s) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 33 && c <= 126) {
      out += String.fromCharCode(33 + ((c + 14) % 94));
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Decrypts a stream URL from protobuf payload:
 * 1. Executes ROT47
 * 2. Strips the 8-character salt prefix
 */
function decryptStreamUrl(encUrl) {
  if (!encUrl || typeof encUrl !== 'string') return '';
  const decoded = rot47(encUrl);
  return decoded.length > 8 ? decoded.slice(8) : decoded;
}

/**
 * Extracts 32-hex character signature from handshake endpoint response
 */
function extractSignature(input) {
  if (!input) return null;
  const str = Buffer.isBuffer(input) ? input.toString('latin1') : String(input);
  const match = str.match(/([0-9a-f]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Computes the 6-character MD5 hash prefix from query parameters sorted by MD5_PARAM_ORDER
 */
function getMd5Prefix(params) {
  if (!params || typeof params !== 'object') return '';
  const sorted = {};
  const keys = Object.keys(params).sort((a, b) => {
    const ia = MD5_PARAM_ORDER.indexOf(a);
    const ib = MD5_PARAM_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const k of keys) sorted[k] = params[k];
  const json = JSON.stringify(sorted);
  return crypto.createHash('md5').update(json).digest('hex').slice(0, 6);
}

/**
 * Signs a decrypted stream URL using the rb-session token via AES-256-CBC
 */
function signStreamUrl(decryptedUrl, rbSession) {
  if (!decryptedUrl || !rbSession) return decryptedUrl;
  try {
    const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
    let encrypted = cipher.update(String(rbSession), 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const token = encodeURIComponent(encrypted) + 'a';
    const u = new URL(decryptedUrl);
    return `${u.origin}/token-${token}${u.pathname}${u.search}`;
  } catch (err) {
    return decryptedUrl;
  }
}

/**
 * Generates an external web player URL for direct fallback viewing
 */
function getWebPlayerUrl(matchId, sportType = 1) {
  const mdata = Buffer.from(`${matchId}_${sportType}`).toString('base64');
  return `https://nadia01eo.tn76degree12ec3out.cfd/player.html?mdata=${mdata}&ilang=en`;
}

module.exports = {
  rot47,
  decryptStreamUrl,
  extractSignature,
  getMd5Prefix,
  signStreamUrl,
  getWebPlayerUrl,
  AES_KEY,
  AES_IV
};
