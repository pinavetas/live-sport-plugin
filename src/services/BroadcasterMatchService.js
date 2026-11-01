'use strict';

/**
 * BroadcasterMatchService
 *
 * Bridges live match fixtures (scraped from DaddyLive, TheSportsDB, etc.)
 * to high-definition 1080p/4K 50fps Vavoo Sunshine CDN streams.
 *
 * Maintains an in-memory O(1) normalized index from TV network / broadcaster names
 * (e.g., "TNT Sports 1", "Sky Sports Main Event", "Movistar LaLiga", "Canal+ Sport")
 * to the corresponding active Vavoo channels.
 */

const fs = require('fs');
const path = require('path');

function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/\b(hd|fhd|uhd|4k|sd|raw|sat|hevc|backup|match time)\b/gi, ' ')
    .replace(/\b(uk|us|de|es|fr|it|pt)\b/gi, ' ')
    .replace(/\bsports\b/gi, 'sport') // normalize sports -> sport
    .replace(/\bsuper\s*sport\b/gi, 'supersport')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

class BroadcasterMatchService {
  constructor(opts = {}) {
    let customPath = null;
    try {
      if (opts && typeof opts === 'object' && opts.catalogPath) {
        customPath = opts.catalogPath;
      }
    } catch (_) {}
    const candidates = [
      customPath,
      path.resolve(__dirname, '../data/vavoo_channels.json'),
      path.resolve(__dirname, './data/vavoo_channels.json'),
      path.resolve(__dirname, './src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'dist/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'data/vavoo_channels.json')
    ].filter(Boolean);
    this._catalogPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
    this._channelIndex = new Map();
    this._aliasIndex = new Map();
    this._initialized = false;
    this._init();
  }

  _init() {
    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    try {
      const channels = JSON.parse(fs.readFileSync(this._catalogPath, 'utf8'));
      if (!Array.isArray(channels)) return;

      const GROUP_PRIORITY = {
        'United Kingdom': 100,
        'Spain': 90,
        'France': 85,
        'Germany': 80,
        'Portugal': 75,
        'Italy': 70
      };

      for (const ch of channels) {
        if (!ch || !ch.name || !ch.vavooUrl) continue;

        const norm = normalizeName(ch.name);
        if (norm) {
          const existing = this._channelIndex.get(norm);
          const existingScore = existing ? (GROUP_PRIORITY[existing.group] || 10) : 0;
          const currentScore = GROUP_PRIORITY[ch.group] || 10;
          if (!existing || currentScore > existingScore) {
            this._channelIndex.set(norm, ch);
          }
        }

        // Index with group context
        if (ch.group) {
          const normWithGroup = normalizeName(`${ch.name} ${ch.group}`);
          if (normWithGroup && !this._channelIndex.has(normWithGroup)) {
            this._channelIndex.set(normWithGroup, ch);
          }
        }
      }

      this._registerKnownAliases();
      this._initialized = true;
    } catch (err) {
      console.error('[BroadcasterMatchService] Failed to index Vavoo channels:', err.message);
    }
  }

  _registerKnownAliases() {
    // Common broadcast network naming discrepancies between schedule scrapers and Vavoo
    const ALIAS_MAPPINGS = [
      // UK
      { alias: 'tnt sports 1', target: 'tnt sport 1' },
      { alias: 'tnt sports 2', target: 'tnt sport 2' },
      { alias: 'tnt sports 3', target: 'tnt sport 3' },
      { alias: 'tnt sports 4', target: 'tnt sport 4' },
      { alias: 'bt sport 1', target: 'tnt sport 1' },
      { alias: 'bt sport 2', target: 'tnt sport 2' },
      { alias: 'bt sport 3', target: 'tnt sport 3' },
      { alias: 'bt sport 4', target: 'tnt sport 4' },
      { alias: 'sky sports main event', target: 'sky sport main event' },
      { alias: 'sky sports premier league', target: 'sky sport premier league' },
      { alias: 'sky sports football', target: 'sky sport football' },
      { alias: 'sky sports f1', target: 'sky sport f1' },
      { alias: 'sky sports cricket', target: 'sky sport cricket' },
      { alias: 'sky sports golf', target: 'sky sport golf' },
      { alias: 'sky sports action', target: 'sky sport action' },
      { alias: 'sky sports arena', target: 'sky sport arena' },
      { alias: 'sky sports mix', target: 'sky sport mix' },
      { alias: 'sky sports news', target: 'sky sport news' },
      { alias: 'premier sports 1', target: 'premier sport 1' },
      { alias: 'premier sports 2', target: 'premier sport 2' },
      // Spain
      { alias: 'movistar laliga', target: 'm laliga' },
      { alias: 'movistar la liga', target: 'm laliga' },
      { alias: 'm laliga', target: 'm laliga' },
      { alias: 'movistar liga de campeones', target: 'm liga de campeones' },
      { alias: 'movistar campeones', target: 'm liga de campeones' },
      { alias: 'movistar deportes', target: 'movistar deportes' },
      { alias: 'dazn laliga', target: 'dazn laliga 1' },
      { alias: 'dazn laliga 1', target: 'dazn laliga 1' },
      { alias: 'dazn laliga 2', target: 'dazn laliga 2' },
      // France
      { alias: 'canal sport', target: 'canal sport' },
      { alias: 'canal foot', target: 'canal foot' },
      { alias: 'canal 360', target: 'canal 360' },
      { alias: 'bein sports 1 fr', target: 'bein sport 1' },
      { alias: 'bein sports 2 fr', target: 'bein sport 2' },
      { alias: 'bein sports 3 fr', target: 'bein sport 3' },
      // Portugal
      { alias: 'sport tv 1', target: 'sport tv 1' },
      { alias: 'sport tv 2', target: 'sport tv 2' },
      { alias: 'sport tv 3', target: 'sport tv 3' },
      { alias: 'sport tv 4', target: 'sport tv 4' },
      { alias: 'eleven sports 1', target: 'eleven sport 1' },
      { alias: 'benfica tv', target: 'btv benfica' },
      // Germany
      { alias: 'sky sport bundesliga', target: 'sky sport bundesliga' },
      { alias: 'sky sport premier league de', target: 'sky sport premier league' },
      { alias: 'dazn 1 de', target: 'dazn 1' },
      { alias: 'dazn 2 de', target: 'dazn 2' },
      // Italy
      { alias: 'sky sport uno', target: 'sky sport uno' },
      { alias: 'sky sport calcio', target: 'sky sport calcio' },
      { alias: 'sky sport f1 it', target: 'sky sport f1' },
      // International / Pan-Regional
      { alias: 'espn', target: 'espn' },
      { alias: 'espn 2', target: 'espn 2' },
      { alias: 'supersport 1', target: 'supersport 1' },
      { alias: 'supersport 2', target: 'supersport 2' },
      { alias: 'supersport 3', target: 'supersport 3' },
      { alias: 'supersport premier league', target: 'supersport 1' },
      { alias: 'supersport football', target: 'supersport 2' },
      { alias: 'supersport grandstand', target: 'supersport 1' },
      { alias: 'supersport laliga', target: 'supersport 3' },
      { alias: 'supersport action', target: 'supersport action' },
      { alias: 'supersport golf', target: 'supersport golf' },
      { alias: 'eurosport 1', target: 'eurosport 1' },
      { alias: 'eurosport 2', target: 'eurosport 2' }
    ];

    for (const { alias, target } of ALIAS_MAPPINGS) {
      const normAlias = normalizeName(alias);
      const normTarget = normalizeName(target);
      const targetCh = this._channelIndex.get(normTarget);
      if (targetCh) {
        this._aliasIndex.set(normAlias, targetCh);
      }
    }
  }

  /**
   * Resolves a raw broadcaster name to an active Vavoo channel.
   * Runs in O(1) via hash table lookups.
   *
   * @param {string} rawChannelName
   * @returns {Object|null}
   */
  findChannel(rawChannelName) {
    if (!rawChannelName || typeof rawChannelName !== 'string') return null;

    const norm = normalizeName(rawChannelName);
    if (!norm) return null;

    // 1. Direct O(1) match on normalized catalog name
    if (this._channelIndex.has(norm)) {
      return this._channelIndex.get(norm);
    }

    // 2. Direct O(1) match on alias dictionary
    if (this._aliasIndex.has(norm)) {
      return this._aliasIndex.get(norm);
    }

    // 3. Whole-word prefix check (e.g. "TNT Sports 1 (HD)" -> starts with "tnt sport 1 ")
    for (const [key, ch] of this._aliasIndex.entries()) {
      if (key.length >= 4 && (norm === key || norm.startsWith(key + ' '))) {
        // Prevent generic unnumbered placeholders like "sky sport" from matching numbered channels like "sky sport 253"
        const remainder = norm.slice(key.length).trim();
        if (/\b\d+\b/.test(remainder) && !/\b\d+\b/.test(key)) continue;
        return ch;
      }
    }

    for (const [key, ch] of this._channelIndex.entries()) {
      if (key.length >= 5 && (norm === key || norm.startsWith(key + ' '))) {
        // Prevent generic unnumbered placeholders like "sky sport" from matching numbered channels like "sky sport 253"
        const remainder = norm.slice(key.length).trim();
        if (/\b\d+\b/.test(remainder) && !/\b\d+\b/.test(key)) continue;
        return ch;
      }
    }

    return null;
  }

  /**
   * Matches a raw broadcaster channel name to a Vavoo StreamSource entity.
   *
   * @param {string} rawChannelName
   * @returns {Object|null} StreamSource compatible object for MatchEntity.sources
   */
  createVavooSource(rawChannelName) {
    const ch = this.findChannel(rawChannelName);
    if (!ch) return null;

    return {
      source: 'vavoo',
      id: ch.vavooUrl,
      channelName: ch.name,
      language: ch.language || undefined,
      group: ch.group,
      is4k: ch.is4k || false,
      type: 'channel'
    };
  }

  /**
   * Takes a list of raw broadcaster channel names from a match schedule
   * and returns deduplicated Vavoo stream sources.
   *
   * @param {Array<string>} channelNames
   * @returns {Array<Object>}
   */
  matchBroadcastersToVavooSources(channelNames) {
    if (!Array.isArray(channelNames) || channelNames.length === 0) return [];

    const sources = [];
    const seenUrls = new Set();

    for (const name of channelNames) {
      const src = this.createVavooSource(name);
      if (src && !seenUrls.has(src.id)) {
        seenUrls.add(src.id);
        sources.push(src);
      }
    }

    return sources;
  }
}

module.exports = BroadcasterMatchService;
