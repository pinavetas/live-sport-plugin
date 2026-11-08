'use strict';

/**
 * BintvProvider.js
 *
 * BINTV (bintv.cc) publishes its whole schedule as one public JSON feed:
 *   { "Live Events": [...], "Upcoming Events": [...], "24/7 Channels": [...] }
 *
 * Every stream is an iframe wrapper `https://bintv-sources.pages.dev/?id=<b64>`
 * whose `id` is the base64url of the real embed URL. Those embeds are the same
 * XOR-obfuscated Clappr pages TimStreams serves (BINTV's posters even come from
 * tim-streams.com), so resolution reuses TimStreamsProvider.extractM3u8 with
 * BINTV's own page referer — the embed host rejects foreign referers with
 * "Access Denied (Domain Not Allowed)".
 */

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const ChannelIdentityService = require('../services/ChannelIdentityService');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const DEFAULT_API_URL = 'https://api.yosintv.fun/api/public/bintvjson';
// Page that iframes the embeds; the embed host allowlists this referer.
const BINTV_PAGE_REFERER = 'https://bintv-sources.pages.dev/';

// The 24/7 list mixes ~220 US/UK/EU general-entertainment channels (HBO, Food
// Network, Nickelodeon...) with sports networks. Keep only the sports ones.
const SPORTS_CHANNEL_RX = /sport|espn|bein|dazn|eleven|\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|golf|tennis|willow|\bufc\b|motogp|\bf1\b|racer|\btsn\d|\btudn\b|deportes|laliga|fight|premiere|acc network|sec network|big ten|dirtvision|\btyc\b|polsat sport|canal\+ sport|arena sport|fox sports|sky sport|tnt sports|cbs sports/i;

const HTML_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(str) {
  // The feed double-escapes some names ("Texas A&amp;amp;M"), so decode until stable.
  let out = String(str || '');
  for (let i = 0; i < 3 && /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(out); i++) {
    out = out.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const rep = HTML_ENTITIES[ent.toLowerCase()];
      return rep !== undefined ? rep : m;
    });
  }
  return out.trim();
}

// streams.js reads the channel label from the first "(...)" of a stream title, so
// labels must not carry their own parentheses ("Fox Sports 501 (Cricket)").
const PARENS_RX = /[()]/g;

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u);
}

/** "2026-11-07 14:00 UTC" -> epoch ms (null when unparseable). */
function parseFeedDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s*(?:UTC|GMT|Z)?$/i);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3] || '00'}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Decode the real embed URL out of a bintv-sources wrapper (`?id=<base64url>`). */
function decodeWrapperUrl(iframeUrl) {
  if (!isHttpUrl(iframeUrl)) return null;
  try {
    const id = new URL(iframeUrl).searchParams.get('id');
    if (!id) return iframeUrl;
    const decoded = Buffer.from(id, 'base64url').toString('utf8').trim();
    return isHttpUrl(decoded) ? decoded : null;
  } catch (_) {
    return null;
  }
}

class BintvProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Bintv';
    this.sourceName = 'bintv';
    this.apiUrl = process.env.BINTV_API_URL || DEFAULT_API_URL;
    // Lazily resolved so a test (or a container without TimStreams) still works.
    this._opts = opts;

    if (this.circuitBreaker) {
      this.fetchFeed = this.circuitBreaker.wrapSync(`${this.name}_fetch`, () => this._fetchFeedInternal());
    }
  }

  get timStreamsProvider() {
    try { return this._opts && this._opts.timStreamsProvider; } catch (_) { return null; }
  }

  async _fetchFeedInternal() {
    const res = await this.proxyFetch(this.apiUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://bintv.cc/' },
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

  /** Pure: feed JSON -> MatchEntity[] (events + sports-only 24/7 channels). */
  parseFeed(data) {
    if (!data || typeof data !== 'object') return [];
    const matches = [];
    const seen = new Set();

    const events = [
      ...(Array.isArray(data['Live Events']) ? data['Live Events'] : []),
      ...(Array.isArray(data['Upcoming Events']) ? data['Upcoming Events'] : []),
    ];
    for (const ev of events) {
      const m = this._eventToMatch(ev);
      if (m && !seen.has(m.id)) { seen.add(m.id); matches.push(m); }
    }

    const channels = Array.isArray(data['24/7 Channels']) ? data['24/7 Channels'] : [];
    for (const ch of channels) {
      const m = this._channelToMatch(ch);
      if (m && !seen.has(m.id)) { seen.add(m.id); matches.push(m); }
    }
    return matches;
  }

  _toSources(streams) {
    const out = [];
    for (const st of Array.isArray(streams) ? streams : []) {
      if (!st) continue;
      const embedUrl = decodeWrapperUrl(st.Iframe);
      if (!embedUrl) continue;
      out.push({
        source: 'bintv',
        id: Buffer.from(embedUrl).toString('base64url'),
        channelName: decodeEntities(st.Name) || 'BINTV',
        embedUrl,
        wrapperUrl: st.Iframe,
      });
    }
    return out;
  }

  _eventToMatch(ev) {
    if (!ev || !ev.ID || !ev.Name) return null;
    const sources = this._toSources(ev.Streams);
    if (sources.length === 0) return null;

    const title = decodeEntities(ev.Name);
    const dateMs = parseFeedDate(ev.Date);
    const isLive = String(ev.Status || '').toLowerCase() === 'live';
    const teams = extractTeamsFromTitle(title);

    return new MatchEntity({
      id: `bintv_${ev.ID}`,
      title,
      category: this.normalizeCategory(ev.Category),
      date: dateMs ? String(dateMs) : '',
      status: isLive ? 'live' : 'upcoming',
      league: ev.Category || '',
      team1: teams ? { name: teams[0] } : null,
      team2: teams ? { name: teams[1] } : null,
      thumbnail_url: isHttpUrl(ev.Poster) ? ev.Poster : '',
      sources,
    });
  }

  _channelToMatch(ch) {
    if (!ch || !ch.Name) return null;
    const name = decodeEntities(ch.Name).replace(PARENS_RX, ' ').replace(/\s+/g, ' ').trim();
    if (!SPORTS_CHANNEL_RX.test(name)) return null;
    const sources = this._toSources(ch.Streams);
    if (sources.length === 0) return null;

    const ident = ChannelIdentityService.parseChannel(name);
    // Slug from the raw name: regional variants ("DAZN 1 Spain" / "DAZN 1 Germany")
    // share a canonical title, and the aggregator — not this provider — decides
    // whether they collapse into one card.
    const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    for (const s of sources) {
      s.canonicalChannel = ident.canonicalTitle;
      s.type = 'channel';
    }
    const entity = new MatchEntity({
      id: `bintv_ch_${slug || ch.ID}`,
      title: ident.canonicalTitle,
      baseTitle: ident.canonicalTitle,
      category: 'networks',
      date: '0',
      popular: '0',
      league: ident.country || 'Live TV',
      sources,
    });
    entity.channelIdentityKey = ident.identityKey;
    entity.channelNumber = ident.channelNumber;
    entity.canonicalTitle = ident.canonicalTitle;
    return entity;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    let embedUrl = isHttpUrl(src.embedUrl) ? src.embedUrl : null;
    if (!embedUrl && sourceId) {
      try {
        const decoded = Buffer.from(String(sourceId), 'base64url').toString('utf8');
        if (isHttpUrl(decoded)) embedUrl = decoded;
      } catch (_) {}
    }
    if (!embedUrl) return streams;

    const label = String(src.channelName || 'BINTV').replace(PARENS_RX, '');
    const ts = this.timStreamsProvider;
    if (ts && typeof ts.extractM3u8 === 'function') {
      try {
        const result = await ts.extractM3u8(embedUrl, BINTV_PAGE_REFERER);
        if (result && isHttpUrl(result.m3u8)) {
          const origin = new URL(result.referer || embedUrl).origin;
          streams.push(new StreamEntity({
            name: 'BINTV',
            title: `BINTV (${label})`,
            url: result.m3u8,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: { request: { 'User-Agent': UA, 'Referer': `${origin}/`, 'Origin': origin } },
            },
            channelName: label,
            resolution: 'HD',
          }));
        }
      } catch (err) {
        console.warn(`[${this.name}] m3u8 extraction failed for ${embedUrl}: ${err.message}`);
      }
    }

    const webUrl = isHttpUrl(src.wrapperUrl) ? src.wrapperUrl : embedUrl;
    streams.push(new StreamEntity({
      name: 'Nuvio Web Player',
      title: `BINTV (${label}) (Web)`,
      externalUrl: `/watch?url=${encodeURIComponent(webUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    }));
    return streams;
  }
}

module.exports = BintvProvider;
module.exports.decodeWrapperUrl = decodeWrapperUrl;
module.exports.parseFeedDate = parseFeedDate;
module.exports.decodeEntities = decodeEntities;
