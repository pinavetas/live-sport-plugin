'use strict';

/**
 * PlooplayerProvider — loads a user-supplied Plooplayer (W3U) list.
 *
 * Unlike the scrapers this provider is not part of the match aggregator: the
 * list URL comes from each install's config (`plooplayerList`), so there is no
 * global catalog to sync. PlooplayerService calls `loadList()` on demand and
 * owns caching; this class only fetches and parses (I3: leaf node).
 *
 * Every request goes through `proxyFetch` (I10). User-supplied URLs are also
 * refused up front when they point at a private or reserved host.
 */

const BaseProvider = require('./BaseProvider');
const { parsePlooList } = require('../services/plooplayer/PlooListParser');
const { assertAllowed } = require('../services/DashUpstream');

const LIST_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';
const LIST_TIMEOUT_MS = Number(process.env.PLOOPLAYER_LIST_TIMEOUT_MS) || 8000;
const LIST_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Paste-site page URLs -> their raw endpoints (the app's `makeBinRaw()`).
 * Only pastebin.com is rewritten; every other host is fetched as given.
 */
function toRawListUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const m = parsed.pathname.match(/^\/([A-Za-z0-9]+)\/?$/);
    if (host === 'pastebin.com' && m && m[1] !== 'raw') {
      parsed.hostname = 'pastebin.com';
      parsed.pathname = `/raw/${m[1]}`;
      return parsed.toString();
    }
  } catch (_) { /* returned unchanged; validated by the caller */ }
  return url;
}

class PlooplayerProvider extends BaseProvider {
  constructor(deps = {}) {
    super(deps);
    this.name = 'Plooplayer';
    this.sourceName = 'plooplayer';
  }

  /** Not an aggregated source: its catalog is per install, see PlooplayerService. */
  async getMatches() {
    return [];
  }

  async fetchListJson(url) {
    const target = toRawListUrl(String(url || '').trim());
    assertAllowed(target);
    const res = await this.proxyFetch(target, {
      headers: { 'User-Agent': LIST_UA, Accept: 'application/json,text/plain,*/*' },
      timeoutMs: LIST_TIMEOUT_MS,
      attempts: 2,
      maxBodyBytes: LIST_MAX_BYTES,
      diagnosticOwner: 'plooplayer'
    });
    if (!res || !res.ok) throw new Error(`list HTTP ${res && res.status}`);
    const text = (await res.text()).replace(/^﻿/, '').trim();
    if (!text.startsWith('{')) throw new Error('list is not a W3U JSON document');
    return JSON.parse(text);
  }

  /**
   * @param {string} listUrl
   * @returns {Promise<object>} PlooListParser tree
   */
  async loadList(listUrl) {
    const root = await this.fetchListJson(listUrl);
    return parsePlooList(root, {
      rootUrl: toRawListUrl(listUrl),
      fetchJson: (url) => this.fetchListJson(url)
    });
  }
}

module.exports = PlooplayerProvider;
module.exports.toRawListUrl = toRawListUrl;
