'use strict';

/**
 * MadPlayResolver.js
 *
 * Core resolver for MadPlay / RBTV+ network:
 * - Dynamic base URL and API host discovery
 * - Protobuf match list extraction and O(1) stream indexing
 * - Match detail querying, ROT47 URL decryption, AES token generation
 * - Direct CDN streaming with proxyHeaders & lightweight manifest proxying
 */

const { safeFetch: _safeFetch } = require('../../impitClient');
const MatchEntity = require('../../domain/MatchEntity');
const StreamEntity = require('../../domain/StreamEntity');
const {
  rot47,
  decryptStreamUrl,
  extractSignature,
  getMd5Prefix,
  signStreamUrl,
  getWebPlayerUrl
} = require('./MadPlayCrypto');
const { decodeProtobuf } = require('./MadPlayProtobuf');

const DEFAULT_BASE_URL = 'https://jack27eo.mpanrc4imind.my/';
const DEFAULT_API_HOST = 'https://apis-data10.tcpwe138stya.ru';
const DEFAULT_FALLBACK_API_HOST = 'https://apis-data-defra10.tcpwe138stya.ru';
const DEFAULT_DIGIT_ENV = 'seth';

const PLAYER_REFERER = 'https://nadia01eo.tn76degree12ec3out.cfd/';
const PLAYER_ORIGIN = 'https://nadia01eo.tn76degree12ec3out.cfd';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Supported sports to query for live events
const SPORT_TYPES = [
  { id: 1, category: 'football' },
  { id: 2, category: 'basketball' },
  { id: 3, category: 'tennis' },
  { id: 9, category: 'cricket' },
  { id: 15, category: 'mma' }
];

class MadPlayResolver {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.MADPLAY_BASE_URL || DEFAULT_BASE_URL;
    this.apiHost = options.apiHost || DEFAULT_API_HOST;
    this.digitEnv = options.digitEnv || DEFAULT_DIGIT_ENV;
    this.fetchFn = options.fetchFn || _safeFetch;
    this.lastDiscoveryTime = 0;
    this.discoveryTtlMs = 60 * 60 * 1000; // 1 hour
  }

  setBaseUrl(url) {
    if (url && typeof url === 'string') {
      this.baseUrl = url.trim().replace(/\/+$/, '') + '/';
      this.lastDiscoveryTime = 0; // Force re-discovery on next fetch
    }
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  mapSportType(sportId) {
    const found = SPORT_TYPES.find(s => s.id === Number(sportId));
    return found ? found.category : 'other';
  }

  /**
   * Discovers current dynamic API Host and DIGIT_ENV from the base URL's Nuxt state
   */
  async discoverConfig(overrideBaseUrl = null) {
    const targetUrl = overrideBaseUrl || this.baseUrl;
    const now = Date.now();
    if (!overrideBaseUrl && this.lastDiscoveryTime && (now - this.lastDiscoveryTime < this.discoveryTtlMs)) {
      return { apiHost: this.apiHost, digitEnv: this.digitEnv };
    }

    try {
      const res = await this.fetchFn(targetUrl, {
        headers: { 'User-Agent': USER_AGENT },
        timeoutMs: 8000
      });
      if (res && (res.ok || res.status === 200)) {
        const html = await res.text();
        const apiMatch = html.match(/CF_DA_API\s*:\s*"([^"]+)"/);
        const digitMatch = html.match(/DIGIT_ENV\s*:\s*"([^"]+)"/);

        if (apiMatch && apiMatch[1]) {
          this.apiHost = apiMatch[1].replace(/\/+$/, '');
        }
        if (digitMatch && digitMatch[1]) {
          this.digitEnv = digitMatch[1];
        }
        this.lastDiscoveryTime = now;
      }
    } catch (err) {
      // Retain fallback defaults if dynamic discovery fails
    }

    return { apiHost: this.apiHost, digitEnv: this.digitEnv };
  }

  /**
   * Fetches matches across all supported sport types
   */
  async getMatches(customBaseUrl = null) {
    await this.discoverConfig(customBaseUrl);
    const allMatches = [];

    for (const sport of SPORT_TYPES) {
      try {
        const sportMatches = await this._getMatchesForSport(sport.id, sport.category);
        if (Array.isArray(sportMatches) && sportMatches.length > 0) {
          allMatches.push(...sportMatches);
        }
      } catch (err) {
        // Individual sport failure does not fail the entire provider
      }
    }

    return allMatches;
  }

  /**
   * Fetches and parses matches for a specific sportType
   */
  async _getMatchesForSport(sportType, category) {
    const headers = {
      'User-Agent': USER_AGENT,
      'Referer': this.baseUrl
    };

    // 1. Handshake signature
    const bsUrl = `${this.apiHost}/api/common/bs?code=100&sportType=${sportType}&stream=true`;
    let bsRes;
    try {
      bsRes = await this.fetchFn(bsUrl, { headers, timeoutMs: 10000 });
    } catch (_) {
      // Fallback mirror if primary host fails
      if (this.apiHost === DEFAULT_API_HOST) {
        this.apiHost = DEFAULT_FALLBACK_API_HOST;
        bsRes = await this.fetchFn(`${this.apiHost}/api/common/bs?code=100&sportType=${sportType}&stream=true`, { headers, timeoutMs: 10000 });
      } else {
        throw _;
      }
    }

    if (!bsRes || (!bsRes.ok && bsRes.status !== 200)) return [];
    const bsBody = Buffer.from(await bsRes.arrayBuffer());
    const signature = extractSignature(bsBody);
    if (!signature) return [];

    // 2. Compute ordered MD5 prefix
    const md5Prefix = getMd5Prefix({ sportType, stream: true });
    const liveEndpoint = `${this.apiHost}/sfver${md5Prefix}${signature}/api/match/live?sportType=${sportType}&stream=true`;

    const liveRes = await this.fetchFn(liveEndpoint, { headers, timeoutMs: 12000 });
    if (!liveRes || (!liveRes.ok && liveRes.status !== 200)) return [];

    const liveBuf = Buffer.from(await liveRes.arrayBuffer());
    const decoded = decodeProtobuf(liveBuf);

    const rawMatches = decoded['10']?.['1'];
    const rawStreams = decoded['10']?.['2'];

    const matchList = Array.isArray(rawMatches) ? rawMatches : (rawMatches ? [rawMatches] : []);
    const streamMarkers = Array.isArray(rawStreams) ? rawStreams : (rawStreams ? [rawStreams] : []);

    // O(1) Hash Map of streaming match IDs
    const streamMap = new Map();
    for (const sm of streamMarkers) {
      const mid = String(sm['50'] || sm['1'] || '');
      if (mid) {
        if (!streamMap.has(mid)) streamMap.set(mid, 0);
        streamMap.set(mid, streamMap.get(mid) + 1);
      }
    }

    const entities = [];
    const now = Date.now();

    for (const m of matchList) {
      const matchId = String(m['1'] || '');
      if (!matchId) continue;

      const hasStreams = streamMap.has(matchId);
      const rawStatus = Number(m['9'] || 0);
      const isLive = hasStreams || (rawStatus >= 2 && rawStatus <= 5);

      // Only include fixtures with active streams or live indicators
      if (!hasStreams && !isLive) continue;

      // Extract match metadata
      let homeTeam = '';
      let awayTeam = '';
      let homeLogo = '';
      let awayLogo = '';
      let title = '';

      if (Array.isArray(m['30'])) {
        title = m['30'][0]?.['2'] || '';
        const homeObj = m['30'][1]?.['10'];
        const awayObj = m['30'][2]?.['10'];
        if (homeObj) {
          homeTeam = homeObj['3']?.['2'] || '';
          homeLogo = homeObj['4'] || '';
        }
        if (awayObj) {
          awayTeam = awayObj['3']?.['2'] || '';
          awayLogo = awayObj['4'] || '';
        }
      }

      if (!title) {
        if (homeTeam && awayTeam) {
          title = `${homeTeam} vs ${awayTeam}`;
        } else {
          title = `Match ${matchId}`;
        }
      }

      const leagueName = m['10']?.['3']?.['2'] || '';
      const leagueLogo = m['10']?.['4'] || '';

      // Match time (milliseconds epoch or seconds epoch)
      let matchTimeMs = Number(m['3'] || 0);
      if (matchTimeMs > 0 && matchTimeMs < 10000000000) {
        matchTimeMs *= 1000;
      }
      if (!matchTimeMs || isNaN(matchTimeMs)) {
        matchTimeMs = now;
      }

      entities.push(new MatchEntity({
        id: `madplay_${matchId}_${sportType}`,
        title: title,
        category: category,
        status: isLive ? 'live' : 'upcoming',
        timestamp: matchTimeMs,
        date: matchTimeMs.toString(),
        popular: isLive ? '1' : '0',
        league: leagueName,
        team1: { name: homeTeam || 'Home', logo: homeLogo },
        team2: { name: awayTeam || 'Away', logo: awayLogo },
        thumbnail_url: homeLogo || awayLogo || leagueLogo || '',
        sources: [{
          source: 'madplay',
          id: `${matchId}_${sportType}`,
          streamCount: streamMap.get(matchId) || 1
        }]
      }));
    }

    return entities;
  }

  /**
   * Resolves playable streams for a specific match sourceId
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}, config = {}, serverBaseUrl = '') {
    const parts = String(sourceId).split('_');
    const matchId = parts[0];
    const sportType = Number(parts[1] || 1);

    if (config?.madplayUrl) {
      await this.discoverConfig(config.madplayUrl);
    }

    const headers = {
      'User-Agent': USER_AGENT,
      'Referer': this.baseUrl
    };

    // 1. Handshake for match detail (code 102)
    const bsUrl = `${this.apiHost}/api/common/bs?code=102&matchId=${matchId}&sportType=${sportType}&stream=true`;
    const bsRes = await this.fetchFn(bsUrl, { headers, timeoutMs: 10000 });
    if (!bsRes || (!bsRes.ok && bsRes.status !== 200)) return [];

    const bsBody = Buffer.from(await bsRes.arrayBuffer());
    const signature = extractSignature(bsBody);
    if (!signature) return [];

    // 2. Fetch match detail
    const md5Prefix = getMd5Prefix({ matchId: String(matchId), sportType, stream: true });
    const detUrl = `${this.apiHost}/sfver${md5Prefix}${signature}/api/match/detail?matchId=${matchId}&sportType=${sportType}&stream=true`;

    const detRes = await this.fetchFn(detUrl, { headers, timeoutMs: 10000 });
    if (!detRes || (!detRes.ok && detRes.status !== 200)) return [];

    const detBuf = Buffer.from(await detRes.arrayBuffer());
    const detDecoded = decodeProtobuf(detBuf);

    const streams = detDecoded['10']?.['2'];
    const streamArr = Array.isArray(streams) ? streams : (streams ? [streams] : []);
    if (streamArr.length === 0) return [];

    const streamEntities = [];

    // Resolve candidates
    for (const [idx, st] of streamArr.entries()) {
      const streamId = String(st['1'] || '');
      if (!streamId) continue;

      const streamName = typeof st['3'] === 'string' && st['3'].trim() ? st['3'].trim() : `Stream ${idx + 1}`;
      const siteType = String(st['9'] || '2001');

      try {
        const streamDetailUrl = `${this.apiHost}/api/stream/detail?streamId=${streamId}&matchId=${matchId}&sportType=${sportType}&siteType=${siteType}&digit=${this.digitEnv}&continent=EU&country=ES`;
        const sRes = await this.fetchFn(streamDetailUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': PLAYER_REFERER,
            'Origin': PLAYER_ORIGIN
          },
          timeoutMs: 10000
        });

        if (!sRes || (!sRes.ok && sRes.status !== 200)) continue;

        const rbSession = sRes.headers && (sRes.headers.get ? sRes.headers.get('rb-session') : sRes.headers['rb-session']);
        const sBuf = Buffer.from(await sRes.arrayBuffer());
        const sDecoded = decodeProtobuf(sBuf);

        let sObj = sDecoded['10']?.['2'];
        if (Array.isArray(sObj)) sObj = sObj[0];

        const encUrl = sObj?.['4'];
        if (!encUrl || typeof encUrl !== 'string') continue;

        const decUrl = decryptStreamUrl(encUrl);
        if (!decUrl.startsWith('http')) continue;

        const signedUrl = signStreamUrl(decUrl, rbSession);

        // Option 1: Lightweight Manifest Proxy (Zero Server Media Bandwidth Bleed)
        const effectiveBaseUrl = serverBaseUrl || (typeof process !== 'undefined' && process.env.ADDON_URL) || '';
        const proxiedUrl = effectiveBaseUrl
          ? `${effectiveBaseUrl}/api/manifest?url=${encodeURIComponent(signedUrl)}&referer=${encodeURIComponent(PLAYER_REFERER)}&origin=${encodeURIComponent(PLAYER_ORIGIN)}`
          : signedUrl;

        streamEntities.push(new StreamEntity({
          name: 'MadPlay',
          title: `${streamName} [HD Direct]`,
          url: proxiedUrl,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                'Referer': PLAYER_REFERER,
                'Origin': PLAYER_ORIGIN,
                'User-Agent': USER_AGENT
              }
            }
          },
          resolution: 'HD'
        }));
      } catch (stErr) {
        // Continue to other stream candidates
      }
    }

    // Always include External Web Player fallback
    const webPlayerUrl = getWebPlayerUrl(matchId, sportType);
    streamEntities.push(new StreamEntity({
      name: 'MadPlay',
      title: `${matchTitle || 'Match'} (Web Player)`,
      externalUrl: webPlayerUrl,
      resolution: 'HD'
    }));

    return streamEntities;
  }
}

module.exports = {
  MadPlayResolver,
  DEFAULT_BASE_URL,
  DEFAULT_API_HOST,
  DEFAULT_FALLBACK_API_HOST,
  DEFAULT_DIGIT_ENV,
  PLAYER_REFERER,
  PLAYER_ORIGIN,
  USER_AGENT
};
