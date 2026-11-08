'use strict';

/**
 * StrumykProvider.js
 *
 * Dedicated live sports provider for Strumyk / Strims24 network (strims24.st).
 * Features:
 * - Direct ingestion from Strims24 catalog API (/api/v1/{sport}/{date})
 * - Flashscore team and fixture name reconciliation
 * - Web player embed streaming (/watch?url=...) for custom Echo/HLS.st tokens
 * - Direct HTTP stream forwarding when available (Zero Server Bandwidth Bleed)
 */

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const SPORTS_MAP = {
  football: 1,
  tennis: 2,
  basketball: 3,
  hockey: 4,
  mma: 28,
  motorsport: 31
};

class StrumykProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Strumyk';
    this.sourceName = 'strumyk';

    let customBase = null;
    let customFlash = null;
    let customFsign = null;
    let customFetch = null;
    let cb = null;
    try {
      if (opts && typeof opts === 'object') {
        if (Object.prototype.hasOwnProperty.call(opts, 'baseUrl')) customBase = opts.baseUrl;
        if (Object.prototype.hasOwnProperty.call(opts, 'flashBase')) customFlash = opts.flashBase;
        if (Object.prototype.hasOwnProperty.call(opts, 'flashFsign')) customFsign = opts.flashFsign;
        if (Object.prototype.hasOwnProperty.call(opts, 'fetchFn')) customFetch = opts.fetchFn;
        if (Object.prototype.hasOwnProperty.call(opts, 'circuitBreaker')) cb = opts.circuitBreaker;
      }
    } catch (_) {}

    this.baseUrl = (customBase || process.env.STRUMYK_BASE_URL || 'https://strims24.st').replace(/\/+$/, '');
    this.flashBase = customFlash || 'https://1.newsoccers.one/2/x/feed';
    this.flashFsign = customFsign || 'SW9D1eZo';
    this.fetchFn = customFetch || globalThis.fetch;
    this.circuitBreaker = cb;

    if (this.circuitBreaker) {
      this.fetchMatchesWrapped = this.circuitBreaker.wrap(`${this.name}_getMatches`, async () => {
        return await this._getMatchesInternal();
      });
    }
  }

  async getMatches() {
    if (this.fetchMatchesWrapped) {
      try {
        return await this.fetchMatchesWrapped.fire();
      } catch (err) {
        console.error(`[${this.name}] CircuitBreaker getMatches failed:`, err.message);
        return [];
      }
    }
    return await this._getMatchesInternal();
  }

  async _fetchFlashscoreMap(sport, sportId) {
    const fsMap = new Map();
    try {
      const url = `${this.flashBase}/f_${sportId}_0_2_en_1`;
      const res = await this.fetchFn(url, {
        headers: {
          'x-fsign': this.flashFsign,
          'User-Agent': UA,
          'Accept': '*/*'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) return fsMap;
      const text = await res.text();
      const parts = text.split('~AA÷');
      for (let i = 1; i < parts.length; i++) {
        const chunk = parts[i];
        const idEnd = chunk.indexOf('¬');
        if (idEnd === -1) continue;
        const id = chunk.slice(0, idEnd);
        const homeMatch = chunk.match(/AE÷([^¬]+)/);
        const awayMatch = chunk.match(/AF÷([^¬]+)/);
        const timeMatch = chunk.match(/AD÷(\d+)/);
        if (homeMatch && awayMatch) {
          fsMap.set(`FS:${id}`, {
            home: homeMatch[1].trim(),
            away: awayMatch[1].trim(),
            time: timeMatch ? Number(timeMatch[1]) * 1000 : 0
          });
        }
      }
    } catch (_) {}
    return fsMap;
  }

  async _getMatchesInternal() {
    const matches = [];
    const today = new Date().toISOString().slice(0, 10);
    const sports = ['football', 'basketball', 'tennis', 'mma', 'motorsport', 'hockey'];

    for (const sport of sports) {
      try {
        const sportId = SPORTS_MAP[sport] || 1;
        const [catRes, fsMap] = await Promise.all([
          this.fetchFn(`${this.baseUrl}/api/v1/${sport}/${today}`, {
            headers: {
              'User-Agent': UA,
              'Referer': `${this.baseUrl}/`,
              'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(6000)
          }),
          this._fetchFlashscoreMap(sport, sportId)
        ]);

        if (!catRes.ok) continue;
        const catData = await catRes.json();
        const items = Array.isArray(catData && catData.items) ? catData.items : [];
        if (items.length === 0) continue;

        // Fetch details for up to 35 items per sport to keep sync fast and responsive
        const targetItems = items.slice(0, 35);
        const detailPromises = targetItems.map(item =>
          this.fetchFn(`${this.baseUrl}/api/v1/match/${encodeURIComponent(item.match_id)}`, {
            headers: {
              'User-Agent': UA,
              'Referer': `${this.baseUrl}/`,
              'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(5000)
          })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        );

        const details = await Promise.all(detailPromises);

        for (let i = 0; i < details.length; i++) {
          const detail = details[i];
          if (!detail || !Array.isArray(detail.custom_urls) || detail.custom_urls.length === 0) continue;

          const matchId = detail.match_id || targetItems[i].match_id;
          const fsInfo = fsMap.get(matchId);

          let title = '';
          let team1 = null;
          let team2 = null;
          let dateStr = '0';

          if (fsInfo) {
            title = `${fsInfo.home} vs ${fsInfo.away}`;
            team1 = { name: fsInfo.home };
            team2 = { name: fsInfo.away };
            if (fsInfo.time > 0) dateStr = String(fsInfo.time);
          } else {
            const firstCu = detail.custom_urls[0];
            title = `Strumyk - ${firstCu.name || sport} (${matchId.replace(/^FS:/, '')})`;
            const extracted = extractTeamsFromTitle(title);
            if (extracted) {
              team1 = { name: extracted[0] };
              team2 = { name: extracted[1] };
            }
          }

          const sources = [];
          for (const cu of detail.custom_urls) {
            if (cu.enabled === false || !cu.url) continue;
            sources.push({
              source: this.sourceName,
              id: `strum_${matchId.replace(/[^a-zA-Z0-9]/g, '_')}_${cu.id || cu.url.slice(0, 8)}`,
              matchId,
              customUrl: cu.url,
              channelName: cu.name || 'Strumyk Stream'
            });
          }

          if (sources.length === 0) continue;

          matches.push(new MatchEntity({
            id: `strumyk_${matchId.replace(/[^a-zA-Z0-9]/g, '_')}`,
            title,
            baseTitle: title,
            category: this.normalizeCategory(sport),
            date: dateStr,
            status: (Number(dateStr) > Date.now()) ? 'upcoming' : 'live',
            team1,
            team2,
            sources
          }));
        }
      } catch (err) {
        console.warn(`[${this.name}] Failed fetching ${sport}:`, err.message);
      }
    }

    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    const customUrl = src.customUrl;
    const matchId = src.matchId || sourceId;

    let targetUrl = customUrl;

    if (!targetUrl) {
      try {
        const res = await this.fetchFn(`${this.baseUrl}/api/v1/match/${encodeURIComponent(matchId)}`, {
          headers: {
            'User-Agent': UA,
            'Referer': `${this.baseUrl}/`,
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
          const detail = await res.json();
          if (Array.isArray(detail.custom_urls) && detail.custom_urls.length > 0) {
            targetUrl = detail.custom_urls[0].url;
          }
        }
      } catch (_) {}
    }

    if (!targetUrl) return streams;

    // Direct HTTP(S) stream if upstream emits raw video URL
    if (/^https?:\/\/.+\.m3u8/i.test(targetUrl)) {
      streams.push(new StreamEntity({
        name: this.name,
        title: `${this.name} - ${src.channelName || 'Stream'} (${matchTitle || 'Live'})`,
        url: targetUrl,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': UA,
              'Referer': `${this.baseUrl}/`,
              'Origin': this.baseUrl
            }
          }
        },
        resolution: 'HD'
      }));
      return streams;
    }

    // 32-hex Echo embed or path
    let playerUrl = '';
    if (/^[a-f0-9]{32}$/i.test(targetUrl)) {
      playerUrl = `https://hls.st/echo/${targetUrl}`;
    } else if (/^https?:\/\//i.test(targetUrl)) {
      playerUrl = targetUrl;
    } else {
      playerUrl = `https://hls.st/${targetUrl.replace(/^\/+/, '')}`;
    }

    streams.push(new StreamEntity({
      name: this.name,
      title: `${this.name} (Web Player) - ${src.channelName || matchTitle || 'Live'}`,
      externalUrl: `/watch?url=${encodeURIComponent(playerUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
    }));

    return streams;
  }
}

module.exports = StrumykProvider;
