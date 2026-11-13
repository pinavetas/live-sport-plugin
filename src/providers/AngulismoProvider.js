'use strict';

/**
 * AngulismoProvider.js
 *
 * AngulismoTV (https://angulismotv.pages.dev) is an Argentine Astro site. Its
 * page script (/scripts/inicio/main.js) loads both the agenda and the channel
 * grid from one public JSON file on GitHub:
 *
 *   https://raw.githubusercontent.com/tadeoallende/repos-web/refs/heads/main/datos.json
 *   {
 *     events:   [{ id, evento: "LaLiga: Valencia vs. Real Madrid", fecha: "2026-11-07 17:00:00",
 *                  competencia, logoUrl, team1Logo, team2Logo,
 *                  canales: [{ name, options: [{ name, iframe }] }] }],
 *     channels: [{ name, logo, show, featured, options: [{ name, iframe }] }]
 *   }
 *
 * `fecha` is Argentina local time (UTC-3, no DST). Each option is either a
 * direct .m3u8 (played by the site with hls.js) or a third-party embed page.
 * Direct playlists are emitted as-is; embeds are fetched once and run through
 * EmbedExtractorChain (most streamtp-family pages carry a plain signed m3u8),
 * with the embed always kept as a web-player fallback. Everything is
 * Spanish-language, so streams are tagged `language: 'Spanish'` for
 * LanguagePriorityService.
 */

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const ChannelIdentityService = require('../services/ChannelIdentityService');
const EmbedExtractorChain = require('../services/EmbedExtractorChain');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const DEFAULT_DATA_URL = 'https://raw.githubusercontent.com/tadeoallende/repos-web/refs/heads/main/datos.json';
const SITE_ORIGIN = 'https://angulismotv.pages.dev';
const ARGENTINA_OFFSET = '-03:00';
const MAX_OPTIONS_PER_CHANNEL = 8;
const EMBED_FETCH_TIMEOUT_MS = 8000;
const EVENT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

// Channel-grid entries that are not TV channels (mini-games, Discord invite,
// multicam page, cartoon loops, the hidden "Varios" grab-bag).
const NON_SPORT_CHANNEL_RX = /^(?:varios|multicam|discord|juegos|dragon ball.*)$/i;
const DIRECT_MEDIA_RX = /\.m3u8(?:[?#]|$)/i;
// Competitions normalizeCategory does not know but which are all football.
const FOOTBALL_COMPETITION_RX = /\bliga\b|\blig\b|\bmls\b|divisi[oó]n|brasileir|\bcopa\b|\bcup\b|torneo|primera|serie a|serie b|championship|eredivisie|libertadores|sudamericana|concacaf|conmebol/i;

// streams.js reads the channel label from the first "(...)" of a stream title, so
// labels must not carry their own parentheses ("Fox Sports 501 (Cricket)").
const PARENS_RX = /[()]/g;

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u);
}

function foldDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** "2026-11-07 17:00:00" (Argentina local) -> epoch ms, or null. */
function parseFecha(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3] || '00'}${ARGENTINA_OFFSET}`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * "LaLiga: Valencia vs. Real Madrid" -> { title: "Valencia vs. Real Madrid", prefix: "LaLiga" }.
 * Only head-to-head titles lose their prefix; for "Fórmula 1: GP Brasil - Clasificación"
 * the series name is what identifies the session, so it is kept.
 */
function splitEventTitle(evento) {
  const raw = String(evento || '').trim();
  const idx = raw.indexOf(':');
  if (idx > 0 && idx < 60) {
    const rest = raw.slice(idx + 1).trim();
    if (/\s(?:vs\.?|v)\s/i.test(rest)) return { title: rest, prefix: raw.slice(0, idx).trim() };
  }
  return { title: raw, prefix: '' };
}

class AngulismoProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Angulismo';
    this.sourceName = 'angulismo';
    this.dataUrl = process.env.ANGULISMO_DATA_URL || DEFAULT_DATA_URL;

    if (this.circuitBreaker) {
      this.fetchData = this.circuitBreaker.wrapSync(`${this.name}_fetch`, () => this._fetchDataInternal());
    }
  }

  async _fetchDataInternal() {
    const res = await this.proxyFetch(this.dataUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeoutMs: 10000,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
    return await res.json();
  }

  async getMatches() {
    let data;
    try {
      data = this.fetchData ? await this.fetchData.fire() : await this._fetchDataInternal();
    } catch (err) {
      console.warn(`[${this.name}] Failed to fetch data: ${err.message}`);
      return [];
    }
    try {
      return this.parseData(data);
    } catch (err) {
      console.warn(`[${this.name}] Failed to parse data: ${err.message}`);
      return [];
    }
  }

  /** Pure: datos.json -> MatchEntity[] (agenda events + visible 24/7 channels). */
  parseData(data) {
    if (!data || typeof data !== 'object') return [];
    const matches = [];
    const seen = new Set();
    for (const ev of Array.isArray(data.events) ? data.events : []) {
      const m = this._eventToMatch(ev);
      if (m && !seen.has(m.id)) { seen.add(m.id); matches.push(m); }
    }
    for (const ch of Array.isArray(data.channels) ? data.channels : []) {
      const m = this._channelToMatch(ch);
      if (m && !seen.has(m.id)) { seen.add(m.id); matches.push(m); }
    }
    return matches;
  }

  _categoryFor(competencia, evento) {
    const folded = foldDiacritics(`${competencia || ''} ${evento || ''}`);
    let cat = this.normalizeCategory(foldDiacritics(competencia));
    if (cat === 'other') cat = this.normalizeCategory(folded);
    if (cat === 'other' && FOOTBALL_COMPETITION_RX.test(folded)) cat = 'football';
    return cat;
  }

  _optionsToSources(channelName, options, extra = {}) {
    const out = [];
    for (const opt of (Array.isArray(options) ? options : []).slice(0, MAX_OPTIONS_PER_CHANNEL)) {
      const url = opt && (opt.iframe || opt.url);
      if (!isHttpUrl(url)) continue;
      const optName = String((opt && opt.name) || '').trim();
      out.push({
        source: 'angulismo',
        id: Buffer.from(url).toString('base64url'),
        channelName,
        optionName: optName,
        url,
        language: /ingl[eé]s|english/i.test(optName) ? 'English' : 'Spanish',
        ...extra,
      });
    }
    return out;
  }

  _eventToMatch(ev) {
    if (!ev || ev.id == null || !ev.evento) return null;
    const sources = [];
    for (const canal of Array.isArray(ev.canales) ? ev.canales : []) {
      const chName = String((canal && canal.name) || '').trim() || 'Angulismo';
      sources.push(...this._optionsToSources(chName, canal && canal.options));
    }
    if (sources.length === 0) return null;

    const { title, prefix } = splitEventTitle(ev.evento);
    const dateMs = parseFecha(ev.fecha);
    const now = Date.now();
    // The agenda keeps the whole day's list; an event that kicked off more than
    // EVENT_MAX_AGE_MS ago is over (same cut-off TimStreams applies).
    if (dateMs && now - dateMs > EVENT_MAX_AGE_MS) return null;
    const status = dateMs && dateMs <= now ? 'live' : 'upcoming';
    const teamParts = title.split(/\s+vs\.?\s+/i);
    const hasTeams = teamParts.length === 2 && teamParts[0] && teamParts[1];

    return new MatchEntity({
      id: `angulismo_${ev.id}`,
      title,
      category: this._categoryFor(ev.competencia, ev.evento),
      date: dateMs ? String(dateMs) : '',
      status,
      league: ev.competencia || prefix || '',
      team1: hasTeams ? { name: teamParts[0].trim(), logo: isHttpUrl(ev.team1Logo) ? ev.team1Logo : undefined } : null,
      team2: hasTeams ? { name: teamParts[1].trim(), logo: isHttpUrl(ev.team2Logo) ? ev.team2Logo : undefined } : null,
      sources,
    });
  }

  _channelToMatch(ch) {
    if (!ch || !ch.name || ch.show === false) return null;
    const name = String(ch.name).replace(PARENS_RX, ' ').replace(/\s+/g, ' ').trim();
    if (NON_SPORT_CHANNEL_RX.test(name)) return null;
    const ident = ChannelIdentityService.parseChannel(name);
    const sources = this._optionsToSources(name, ch.options, {
      canonicalChannel: ident.canonicalTitle,
      type: 'channel',
    });
    if (isHttpUrl(ch.url) && !sources.some(s => s.url === ch.url)) {
      sources.push(...this._optionsToSources(name, [{ name: 'Directo', iframe: ch.url }], { canonicalChannel: ident.canonicalTitle, type: 'channel' }));
    }
    if (sources.length === 0) return null;

    const slug = foldDiacritics(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const entity = new MatchEntity({
      id: `angulismo_ch_${slug}`,
      title: ident.canonicalTitle,
      baseTitle: ident.canonicalTitle,
      category: 'networks',
      date: '0',
      popular: ch.featured ? '1' : '0',
      league: 'Latinoamérica',
      logo: isHttpUrl(ch.logo) ? ch.logo : undefined,
      sources,
    });
    entity.channelIdentityKey = ident.identityKey;
    entity.channelNumber = ident.channelNumber;
    entity.canonicalTitle = ident.canonicalTitle;
    return entity;
  }

  _directStream(url, referer, src, label) {
    const origin = new URL(referer).origin;
    return new StreamEntity({
      name: 'Angulismo',
      title: `Angulismo (${label})`,
      url,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: { 'User-Agent': UA, 'Referer': `${origin}/`, 'Origin': origin } },
      },
      language: src.language || 'Spanish',
      channelName: src.channelName,
      resolution: 'HD',
    });
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    let url = isHttpUrl(src.url) ? src.url : null;
    if (!url && sourceId) {
      try {
        const decoded = Buffer.from(String(sourceId), 'base64url').toString('utf8');
        if (isHttpUrl(decoded)) url = decoded;
      } catch (_) {}
    }
    if (!url) return [];

    const label = ([src.channelName, src.optionName].filter(Boolean).join(' · ') || 'Angulismo').replace(PARENS_RX, '');

    // The site plays these with hls.js from its own origin.
    if (DIRECT_MEDIA_RX.test(url)) {
      return [this._directStream(url, SITE_ORIGIN, src, label)];
    }

    const streams = [];
    try {
      const res = await this.proxyFetch(url, {
        headers: { 'User-Agent': UA, 'Referer': `${SITE_ORIGIN}/`, 'Sec-Fetch-Dest': 'iframe' },
        timeoutMs: EMBED_FETCH_TIMEOUT_MS,
        attempts: 1,
      });
      if (res && res.ok) {
        const found = EmbedExtractorChain.extract(await res.text());
        if (found && isHttpUrl(found.url)) streams.push(this._directStream(found.url, url, src, label));
      }
    } catch (err) {
      console.warn(`[${this.name}] Embed extraction failed for ${url}: ${err.message}`);
    }

    streams.push(new StreamEntity({
      name: 'Web Player',
      title: `Angulismo (${label}) (Web)`,
      externalUrl: `/watch?url=${encodeURIComponent(url)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
      language: src.language || 'Spanish',
    }));
    return streams;
  }
}

module.exports = AngulismoProvider;
module.exports.parseFecha = parseFecha;
module.exports.splitEventTitle = splitEventTitle;
