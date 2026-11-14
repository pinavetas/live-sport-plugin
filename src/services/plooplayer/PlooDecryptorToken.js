'use strict';

/**
 * PlooDecryptorToken — the `d` parameter the add-on hands to the user's local
 * decryptor (see localDecryptor.js).
 *
 *   d = base64url(JSON { v: 1, u: mpdUrl, k: { kidHex: keyHex }, h: { header: value } })
 *
 * Not signed on purpose: the decryptor listens on the viewer's own device or
 * LAN, the keys are the ones the public list already publishes, and the add-on
 * (Vercel) never sees the media. What *is* enforced on decode is the shape:
 * an http(s) URL, 128-bit hex keys and an allowlist of request headers, so a
 * crafted token cannot inject arbitrary headers or schemes.
 *
 * Shared by the add-on and the local decryptor: node core modules only.
 */

const VERSION = 1;
const MAX_TOKEN_CHARS = 8192;
const HEX32 = /^[0-9a-f]{32}$/;
const ALLOWED_HEADERS = new Map([
  ['referer', 'Referer'],
  ['origin', 'Origin'],
  ['user-agent', 'User-Agent']
]);

function cleanHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    const canonical = ALLOWED_HEADERS.get(String(name).toLowerCase());
    if (!canonical || typeof value !== 'string') continue;
    const v = value.trim();
    if (v && !/[\r\n]/.test(v)) out[canonical] = v;
  }
  return out;
}

function cleanKeys(keys) {
  const out = {};
  if (!keys || typeof keys !== 'object') return out;
  for (const [kid, key] of Object.entries(keys)) {
    const k = String(kid).toLowerCase().replace(/-/g, '');
    const v = String(key).toLowerCase();
    if (HEX32.test(k) && HEX32.test(v)) out[k] = v;
  }
  return out;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * @param {{mpdUrl: string, keys?: object, headers?: object}} input
 * @returns {string} base64url token
 */
function encodeDecryptorToken(input) {
  const mpdUrl = input && input.mpdUrl;
  if (!isHttpUrl(mpdUrl)) throw new Error('decryptor token needs an http(s) manifest URL');
  const body = { v: VERSION, u: mpdUrl, k: cleanKeys(input.keys), h: cleanHeaders(input.headers) };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/**
 * @param {string} token
 * @returns {{mpdUrl: string, keys: object, headers: object} | null}
 */
function decodeDecryptorToken(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_CHARS) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!body || typeof body !== 'object' || body.v !== VERSION || !isHttpUrl(body.u)) return null;
  return { mpdUrl: body.u, keys: cleanKeys(body.k), headers: cleanHeaders(body.h) };
}

module.exports = { encodeDecryptorToken, decodeDecryptorToken };
