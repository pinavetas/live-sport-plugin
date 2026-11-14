'use strict';

/**
 * PlooListParser — turns a Plooplayer W3U list (JSON) into a clean tree.
 *
 *   list   { name, author, info, pl, groups[], stations[] }
 *   group  { name, image, info, p, groups[], stations[], ploorl|url, import }
 *   station{ name, image, info, p, embed, isHost, ploorl|url, qqs{qs[],isbase64},
 *            ploore|referer, ploori|origin, ploousag|userAgent }
 *
 * Field meanings verified against live lists (2026-11-14):
 *   - `ploorl`   encrypted URL: a playable stream on stations, a sub-list on groups
 *   - `ploore` / `ploori` / `ploousag`  encrypted Referer / Origin / User-Agent
 *     (`referer` / `origin` / `userAgent` are the plain-text equivalents)
 *   - `qqs.qs[]` encrypted "kidHex:keyHex" ClearKey pairs, one per KID
 *   - `embed: "true"`  a web page (Telegram, event websites), not a stream
 *   - `p` + `info: "… (Mira 2 anuncios)"`  the app's ad wall; carries no data
 *   - `pl`       encrypted minimum app version
 *   - `import: true` on a group: the sub-list is spliced in at that level. A
 *     plain `ploorl` group navigates into the sub-list. Both end up as the
 *     group's children here.
 *
 * Pure apart from the injected `fetchJson`; never throws on a bad sub-list
 * (the group is kept, empty, with `failed: true`).
 */

const { tryDecryptPloo } = require('./PlooCrypto');

const KIND = Object.freeze({
  DASH: 'dash',
  HLS: 'hls',
  ACESTREAM: 'acestream',
  DIRECT: 'direct',
  WEB: 'web'
});

const HEX32 = /^[0-9a-f]{32}$/i;
const AD_WALL_INFO = /mira\s+\d+\s+anuncios|contenido\s+premium/i;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_SUBLISTS = 40;

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTruthyFlag(value) {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

/** Encrypted field first, plain field as fallback. */
function plainOrEncrypted(raw, encryptedKey, plainKey) {
  return str(tryDecryptPloo(raw[encryptedKey])) || str(raw[plainKey]);
}

/** A 16-byte key/KID given as hex, base64 or base64url -> lowercase hex. */
function toHex16(value) {
  const v = str(value).replace(/-/g, '');
  if (HEX32.test(v)) return v.toLowerCase();
  try {
    const buf = Buffer.from(str(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === 16) return buf.toString('hex');
  } catch (_) { /* not base64 */ }
  return '';
}

/** `qqs.qs[]` -> { kidHex: keyHex }. Undecodable pairs are skipped. */
function parseKeys(qqs) {
  const keys = {};
  const list = qqs && Array.isArray(qqs.qs) ? qqs.qs : [];
  for (const entry of list) {
    const plain = tryDecryptPloo(entry) || (isTruthyFlag(qqs.isbase64) ? str(entry) : '');
    if (!plain) continue;
    const sep = plain.indexOf(':');
    if (sep <= 0) continue;
    const kid = toHex16(plain.slice(0, sep));
    const key = toHex16(plain.slice(sep + 1));
    if (kid && key) keys[kid] = key;
  }
  return keys;
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function cleanInfo(value) {
  const info = str(value);
  return info && !AD_WALL_INFO.test(info) ? info : '';
}

/**
 * One station -> { name, image, info, kind, url, keys, headers }, or null when
 * it carries nothing usable (no URL, unknown scheme).
 */
function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = str(tryDecryptPloo(raw.ploorl)) || str(raw.url);
  if (!url) return null;

  const name = str(raw.name) || 'Canal';
  const base = { name, image: str(raw.image), info: cleanInfo(raw.info) };

  if (/^acestream:/i.test(url)) {
    return { ...base, kind: KIND.ACESTREAM, url, keys: {}, headers: {} };
  }
  if (!isHttpUrl(url)) return null;
  if (isTruthyFlag(raw.embed)) {
    return { ...base, kind: KIND.WEB, url, keys: {}, headers: {} };
  }

  const keys = parseKeys(raw.qqs);
  const headers = {};
  const referer = plainOrEncrypted(raw, 'ploore', 'referer');
  const origin = plainOrEncrypted(raw, 'ploori', 'origin');
  const userAgent = plainOrEncrypted(raw, 'ploousag', 'userAgent');
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;
  if (userAgent) headers['User-Agent'] = userAgent;

  const path = pathnameOf(url);
  let kind = KIND.DIRECT;
  if (Object.keys(keys).length > 0 || path.endsWith('.mpd')) kind = KIND.DASH;
  else if (path.endsWith('.m3u8') || path.endsWith('.m3u')) kind = KIND.HLS;

  return { ...base, kind, url, keys, headers };
}

function normalizeStations(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const station = normalizeStation(raw);
    if (station) out.push(station);
  }
  return out;
}

/**
 * Walks a list, following every sub-list (`ploorl`/`url` on a group).
 *
 * @param {object} json            the parsed root list
 * @param {object} opts
 * @param {(url: string) => Promise<object>} opts.fetchJson  resolves a sub-list (throws on failure)
 * @param {string} [opts.rootUrl]  used for cycle detection
 * @param {number} [opts.maxDepth]
 * @param {number} [opts.maxSublists]
 * @returns {Promise<{name, author, info, groups, stations, stats}>}
 */
async function parsePlooList(json, opts = {}) {
  const fetchJson = opts.fetchJson;
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxSublists = Number.isInteger(opts.maxSublists) ? opts.maxSublists : DEFAULT_MAX_SUBLISTS;
  const seen = new Set(opts.rootUrl ? [opts.rootUrl] : []);
  const stats = { sublists: 0, failedSublists: 0, skippedSublists: 0 };

  async function walkContainer(container, depth) {
    const groups = Array.isArray(container && container.groups) ? container.groups : [];
    return {
      stations: normalizeStations(container && container.stations),
      groups: await Promise.all(groups.map((g) => walkGroup(g, depth + 1)))
    };
  }

  async function walkGroup(raw, depth) {
    const node = {
      name: str(raw && raw.name) || 'Grupo',
      image: str(raw && raw.image),
      info: cleanInfo(raw && raw.info),
      groups: [],
      stations: []
    };
    if (!raw || typeof raw !== 'object') return node;

    const inline = await walkContainer(raw, depth);
    node.stations = inline.stations;
    node.groups = inline.groups;

    const target = str(tryDecryptPloo(raw.ploorl)) || str(raw.url);
    if (!target || !isHttpUrl(target) || typeof fetchJson !== 'function') return node;

    if (seen.has(target) || depth > maxDepth || stats.sublists >= maxSublists) {
      stats.skippedSublists += 1;
      return node;
    }
    seen.add(target);
    stats.sublists += 1;

    try {
      const sub = await fetchJson(target);
      if (!sub || typeof sub !== 'object') throw new Error('sub-list is not a JSON object');
      const walked = await walkContainer(sub, depth);
      node.stations = node.stations.concat(walked.stations);
      node.groups = node.groups.concat(walked.groups);
    } catch (_) {
      stats.failedSublists += 1;
      node.failed = true;
    }
    return node;
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Plooplayer list is not a JSON object');
  }
  const root = await walkContainer(json, 0);
  return {
    name: str(json.name),
    author: str(json.author),
    info: cleanInfo(json.info),
    groups: root.groups,
    stations: root.stations,
    stats
  };
}

module.exports = { parsePlooList, normalizeStation, parseKeys, toHex16, KIND };
