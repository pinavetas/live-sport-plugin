'use strict';

/**
 * NbaMonsterProvider.js
 *
 * NBAMonster (https://nbamonster.com, Cloudflare-fronted, no challenge) feeds
 * its home page from a public JSON endpoint:
 *
 *   GET /api/live/nba
 *   { day, live_games: [{ id, espn_id, espn_state: "pre"|"in"|"post", espn_completed,
 *                         home, away, home_logo, away_logo, kickoff_ms, ended_ms,
 *                         links: [{ Name, URL: "https://piratecat.store/smartplayer.php?hd=<team>=ch01" }] }],
 *     channels: [{ name: "NBA TV", slug, logo, links: [{ URL }] }] }
 *
 * Each link is a "smartplayer" wrapper whose only job is to iframe a
 * third-party embed. Resolution fetches the wrapper, reads that iframe and:
 *   - for the taifood-blog / embedindia family (the same backend PPV.st uses),
 *     delegates to PpvStProvider's proven WASM extraction;
 *   - otherwise runs the embed page through EmbedExtractorChain once.
 * The wrapper is always kept as a web-player fallback.
 */

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const ChannelIdentityService = require('../services/ChannelIdentityService');
const EmbedExtractorChain = require('../services/EmbedExtractorChain');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const DEFAULT_BASE_URL = 'https://nbamonster.com';
const FETCH_TIMEOUT_MS = 8000;
// Embeds served by the PPV.st backend (resolved by PpvStProvider's gasm worker).
const PPV_EMBED_RX = /^https?:\/\/[^/]*(?:taifood|embedindia)[^/]*\/embed(?:-noads)?\//i;

// streams.js reads the channel label from the first "(...)" of a stream title, so
// labels must not carry their own parentheses ("Fox Sports 501 (Cricket)").
const PARENS_RX = /[()]/g;

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u);
}

function absolutize(base, path) {
  if (!path || typeof path !== 'string') return undefined;
  if (isHttpUrl(path)) return path;
  try { return new URL(path, base).toString(); } catch (_) { return undefined; }
}

/** First <iframe src> in a wrapper page, resolved against the page URL. */
function extractIframeSrc(html, pageUrl) {
  const m = String(html || '').match(/<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  const src = absolutize(pageUrl, m[1].replace(/&amp;/g, '&'));
  return isHttpUrl(src) ? src : null;
}

class NbaMonsterProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'NbaMonster';
    this.sourceName = 'nbamonster';
    this.baseUrl = (process.env.NBAMONSTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._opts = opts;

    if (this.circuitBreaker) {
      this.fetchFeed = this.circuitBreaker.wrapSync(`${this.name}_fetch`, () => this._fetchFeedInternal());
    }
  }

  get ppvStProvider() {
    try { return this._opts && this._opts.ppvStProvider; } catch (_) { return null; }
  }

  async _fetchFeedInternal() {
    const res = await this.proxyFetch(`${this.baseUrl}/api/live/nba`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `${this.baseUrl}/home6` },
      timeoutMs: 10000,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
    return await res.json();
  }

  async getMatches() {
    let data;
    try {
      data = this.fetchFeed ? await this.fetchFeed.fire() : await this._fetchFeedInternal();
    } catch (err) {
      console.warn(`[${this.name}] Failed to fetch feed: ${err.message}`);
      return [];
    }
    try {
      return this.parseFeed(data);
    } catch (err) {
      console.warn(`[${this.name}] Failed to parse feed: ${err.message}`);
      return [];
    }
  }

  /** Pure: /api/live/nba JSON -> MatchEntity[] (games + 24/7 channels). */
  parseFeed(data, now = Date.now()) {
    if (!data || typeof data !== 'object') return [];
    const matches = [];
    const seen = new Set();
    for (const g of Array.isArray(data.live_games) ? data.live_games : []) {
      const m = this._gameToMatch(g, now);
      if (m && !seen.has(m.id)) { seen.add(m.id); matches.push(m); }
    }
    for (const ch of Array.isArray(data.channels) ? data.channels : []) {
      const m = this._channelToMatch(ch);
      if (m && !seen.has(m.id)) { seen.add(m.id); matches.push(m); }
    }
    return matches;
  }

  _linksToSources(links, label, extra = {}) {
    const out = [];
    const seenUrls = new Set();
    for (const link of Array.isArray(links) ? links : []) {
      const url = link && link.URL;
      if (!isHttpUrl(url) || seenUrls.has(url)) continue;
      seenUrls.add(url);
      out.push({
        source: 'nbamonster',
        id: Buffer.from(url).toString('base64url'),
        channelName: (link.Name && String(link.Name).trim()) || `${label} ${out.length + 1}`,
        url,
        ...extra,
      });
    }
    return out;
  }

  _gameToMatch(g, now) {
    if (!g || !g.home || !g.away) return null;
    if (g.espn_completed || g.espn_state === 'post') return null;
    const kickoff = Number(g.kickoff_ms);
    if (!Number.isFinite(kickoff) || kickoff <= 0) return null;
    const endedMs = Number(g.ended_ms);
    if (Number.isFinite(endedMs) && endedMs > 0 && now > endedMs) return null;

    const sources = this._linksToSources(g.links, 'Link');
    if (sources.length === 0) return null;

    const isLive = g.espn_state === 'in' || kickoff <= now;
    return new MatchEntity({
      id: `nbamonster_${g.espn_id || g.id}`,
      title: `${g.away} @ ${g.home}`,
      category: 'basketball',
      date: String(kickoff),
      status: isLive ? 'live' : 'upcoming',
      league: 'NBA',
      team1: { name: g.away, logo: absolutize(this.baseUrl, g.away_logo) },
      team2: { name: g.home, logo: absolutize(this.baseUrl, g.home_logo) },
      sources,
    });
  }

  _channelToMatch(ch) {
    if (!ch || !ch.name) return null;
    const name = String(ch.name).trim();
    const ident = ChannelIdentityService.parseChannel(name);
    const sources = this._linksToSources(ch.links, ident.canonicalTitle, {
      canonicalChannel: ident.canonicalTitle,
      type: 'channel',
    });
    if (sources.length === 0) return null;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const entity = new MatchEntity({
      id: `nbamonster_ch_${slug}`,
      title: ident.canonicalTitle,
      baseTitle: ident.canonicalTitle,
      category: 'networks',
      date: '0',
      popular: '0',
      league: ident.country || 'Live TV',
      logo: absolutize(this.baseUrl, ch.logo),
      sources,
    });
    entity.channelIdentityKey = ident.identityKey;
    entity.channelNumber = ident.channelNumber;
    entity.canonicalTitle = ident.canonicalTitle;
    return entity;
  }

  // Both the smartplayer wrapper and the embeds are iframe documents; piratecat
  // answers "Access Denied" unless the request says so (Sec-Fetch-Dest: iframe).
  async _fetchText(url, referer) {
    const res = await this.proxyFetch(url, {
      headers: { 'User-Agent': UA, 'Referer': referer, 'Sec-Fetch-Dest': 'iframe' },
      timeoutMs: FETCH_TIMEOUT_MS,
      attempts: 1,
    });
    if (!res || !res.ok) return null;
    return await res.text();
  }

  async _resolveEmbed(embedUrl, wrapperUrl, matchCategory, matchTitle, label) {
    if (PPV_EMBED_RX.test(embedUrl)) {
      const ppv = this.ppvStProvider;
      if (!ppv || typeof ppv.resolveStream !== 'function') return [];
      const resolved = await ppv.resolveStream(embedUrl, matchCategory, matchTitle, { embedUrl, channelName: label });
      // PpvSt appends its own web fallback on failure; we add ours below.
      return (resolved || []).filter(s => s && s.url).map(s => {
        s.name = 'NBAMonster';
        s.title = `NBAMonster (${label})`;
        return s;
      });
    }

    const html = await this._fetchText(embedUrl, wrapperUrl);
    const found = html ? EmbedExtractorChain.extract(html) : null;
    const m3u8 = found && found.url;
    if (!isHttpUrl(m3u8)) return [];
    const origin = new URL(embedUrl).origin;
    return [new StreamEntity({
      name: 'NBAMonster',
      title: `NBAMonster (${label})`,
      url: m3u8,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: { 'User-Agent': UA, 'Referer': `${origin}/`, 'Origin': origin } },
      },
      resolution: 'HD',
    })];
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    let wrapperUrl = isHttpUrl(src.url) ? src.url : null;
    if (!wrapperUrl && sourceId) {
      try {
        const decoded = Buffer.from(String(sourceId), 'base64url').toString('utf8');
        if (isHttpUrl(decoded)) wrapperUrl = decoded;
      } catch (_) {}
    }
    if (!wrapperUrl) return [];

    const label = String(src.channelName || 'NBAMonster').replace(PARENS_RX, '');
    const streams = [];
    try {
      const html = await this._fetchText(wrapperUrl, `${this.baseUrl}/`);
      const embedUrl = html ? extractIframeSrc(html, wrapperUrl) : null;
      if (embedUrl) {
        streams.push(...await this._resolveEmbed(embedUrl, wrapperUrl, matchCategory, matchTitle, label));
      }
    } catch (err) {
      console.warn(`[${this.name}] Resolve failed for ${wrapperUrl}: ${err.message}`);
    }

    streams.push(new StreamEntity({
      name: 'Nuvio Web Player',
      title: `NBAMonster (${label}) (Web)`,
      externalUrl: `/watch?url=${encodeURIComponent(wrapperUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    }));
    return streams;
  }
}

module.exports = NbaMonsterProvider;
module.exports.extractIframeSrc = extractIframeSrc;
