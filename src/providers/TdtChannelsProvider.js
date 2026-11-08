'use strict';

/**
 * TdtChannelsProvider.js
 *
 * TDTChannels (github.com/LaQuay/TDTChannels) is the community-maintained list
 * of legal, free-to-air Spanish TV streams published by the broadcasters
 * themselves (RTVE, 3Cat, EITB, club channels...). JSON list:
 *   https://www.tdtchannels.com/lists/tv.json
 *   { countries: [{ name: "Spain", ambits: [{ name: "Deportivos", channels: [
 *       { name, logo, epg_id, extra_info, options: [{ format: "m3u8", url, geo2, res, lang }] }
 *   ] }] }] }
 *
 * Only sports channels are exposed: the whole "Deportivos" ambit plus the
 * sports event channels from other ambits (e.g. "+tdp", Teledeporte's overflow
 * feed). Only direct HLS options are kept — YouTube/Twitch/iframe entries are
 * mostly off-air event placeholders. The CDNs send `Access-Control-Allow-Origin: *`
 * and need no headers, so streams are emitted web-ready and play straight from
 * the broadcaster (no server bandwidth). The list changes rarely, so it is
 * cached in-process for LIST_TTL_MS with single-flight refreshes.
 */

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const ChannelIdentityService = require('../services/ChannelIdentityService');

const DEFAULT_LIST_URL = 'https://www.tdtchannels.com/lists/tv.json';
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const SPORTS_AMBIT = 'deportivos';
// Sports channels that TDTChannels files under a non-sports ambit.
const EXTRA_SPORTS_CHANNEL_RX = /^\+tdp$|teledeporte/i;

// streams.js reads the channel label from the first "(...)" of a stream title, so
// labels must not carry their own parentheses ("Fox Sports 501 (Cricket)").
const PARENS_RX = /[()]/g;

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u);
}

/** A usable option is a direct HLS URL without ad-insertion template slots ("[IP]", "[UA]"...). */
function isPlayableOption(opt) {
  return Boolean(opt && String(opt.format || '').toLowerCase() === 'm3u8' && isHttpUrl(opt.url) && !/[[\]]/.test(opt.url));
}

class TdtChannelsProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'TdtChannels';
    this.sourceName = 'tdtchannels';
    this.listUrl = process.env.TDTCHANNELS_URL || DEFAULT_LIST_URL;
    this._cache = null;      // { at, data }
    this._inflight = null;   // single-flight refresh promise

    if (this.circuitBreaker) {
      this.fetchList = this.circuitBreaker.wrapSync(`${this.name}_fetch`, () => this._fetchListInternal());
    }
  }

  async _fetchListInternal() {
    const res = await this.proxyFetch(this.listUrl, {
      headers: { 'Accept': 'application/json' },
      timeoutMs: 15000,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
    return await res.json();
  }

  // The raw list is cached, not the entities: the aggregator mutates the rows
  // it ingests, so every sync gets freshly built MatchEntity objects (the
  // sports subset is ~10 channels, so re-parsing is negligible).
  async getMatches() {
    try {
      return this.parseList(await this._getList());
    } catch (err) {
      console.warn(`[${this.name}] Failed to build channels: ${err.message}`);
      return [];
    }
  }

  async _getList() {
    if (this._cache && Date.now() - this._cache.at < LIST_TTL_MS) return this._cache.data;
    if (this._inflight) return this._inflight;

    this._inflight = (async () => {
      try {
        const data = this.fetchList ? await this.fetchList.fire() : await this._fetchListInternal();
        if (this.parseList(data).length > 0) this._cache = { at: Date.now(), data };
        return data;
      } catch (err) {
        console.warn(`[${this.name}] Failed to fetch list: ${err.message}`);
        // A stale list beats nothing: these channel URLs are long-lived.
        return this._cache ? this._cache.data : null;
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  /** Pure: tv.json -> MatchEntity[] of Spanish sports channels with direct HLS. */
  parseList(data) {
    const countries = data && Array.isArray(data.countries) ? data.countries : [];
    const spain = countries.find(c => c && /^(spain|españa)$/i.test(String(c.name || '').trim()));
    if (!spain || !Array.isArray(spain.ambits)) return [];

    const matches = [];
    const seen = new Set();
    for (const ambit of spain.ambits) {
      if (!ambit || !Array.isArray(ambit.channels)) continue;
      const isSportsAmbit = String(ambit.name || '').trim().toLowerCase() === SPORTS_AMBIT;
      for (const ch of ambit.channels) {
        if (!ch || !ch.name) continue;
        if (!isSportsAmbit && !EXTRA_SPORTS_CHANNEL_RX.test(String(ch.name).trim())) continue;
        const m = this._channelToMatch(ch);
        if (m && !seen.has(m.id)) { seen.add(m.id); matches.push(m); }
      }
    }
    return matches;
  }

  _channelToMatch(ch) {
    const name = String(ch.name).replace(PARENS_RX, ' ').replace(/\s+/g, ' ').trim();
    const options = (Array.isArray(ch.options) ? ch.options : []).filter(isPlayableOption);
    if (options.length === 0) return null;

    const ident = ChannelIdentityService.parseChannel(name, { country: 'Spain' });
    const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const sources = options.map((opt, i) => ({
      source: 'tdtchannels',
      id: Buffer.from(opt.url).toString('base64url'),
      channelName: name,
      canonicalChannel: ident.canonicalTitle,
      optionIndex: i + 1,
      url: opt.url,
      geo: opt.geo2 || null,
      country: 'Spain',
      countryCode: 'ES',
      countryFlag: '🇪🇸',
      language: 'Spanish',
      type: 'channel',
    }));

    const entity = new MatchEntity({
      id: `tdt_ch_${slug}`,
      title: ident.canonicalTitle,
      baseTitle: ident.canonicalTitle,
      category: 'networks',
      date: '0',
      popular: '0',
      league: 'Spain',
      logo: isHttpUrl(ch.logo) ? ch.logo : undefined,
      sources,
    });
    entity.channelIdentityKey = ident.identityKey;
    entity.channelNumber = ident.channelNumber;
    entity.canonicalTitle = ident.canonicalTitle;
    return entity;
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

    const channel = String(src.channelName || matchTitle || 'TDTChannels').replace(PARENS_RX, '');
    const optionTag = src.optionIndex > 1 ? ` #${src.optionIndex}` : '';
    const geoTag = src.geo ? ` [Geo ${src.geo}]` : '';
    return [new StreamEntity({
      name: 'TDTChannels',
      title: `TDTChannels (${channel})${optionTag}${geoTag}`,
      url,
      behaviorHints: { notWebReady: false },
      language: 'Spanish',
      country: 'Spain',
      countryCode: 'ES',
      countryFlag: '🇪🇸',
      channelName: channel,
      canonicalChannel: src.canonicalChannel || channel,
      resolution: 'HD',
    })];
  }
}

module.exports = TdtChannelsProvider;
module.exports.isPlayableOption = isPlayableOption;
