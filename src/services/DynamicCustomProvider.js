'use strict';

const cheerio = require('cheerio');
const BaseProvider = require('../providers/BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { safeFetch } = require('../impitClient');
const { extract: extractChain } = require('./EmbedExtractorChain');
const SpaHydrator = require('./SpaHydrator');

class DynamicCustomProvider extends BaseProvider {
  constructor(config, opts = {}) {
    super(opts);
    this.config = config;
    this.name = config.displayName || config.name || 'Custom Replays';
    this.sourceName = (config.name || 'custom').toLowerCase().replace(/[^a-z0-9]/g, '');
    this.baseUrl = config.baseUrl;
    this.defaultCategory = config.category || 'other';

    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };
  }

  async getMatches() {
    const matches = [];
    try {
      const res = await safeFetch(this.baseUrl, {
        headers: this.defaultHeaders,
        timeoutMs: 15000,
        attempts: 2
      });

      if (!res.ok) {
        console.warn(`[${this.name}] HTTP ${res.status} when fetching catalog from ${this.baseUrl}`);
        return [];
      }

      const rawHtml = await res.text();
      const html = SpaHydrator.hydrate(rawHtml, this.baseUrl);
      const $ = cheerio.load(html);
      const selectors = this.config.selectors || {};

      if (!selectors.matches) return [];

      $(selectors.matches).each((i, el) => {
        let title = '';
        if (selectors.title) {
          title = $(el).find(selectors.title).first().text().trim();
          if (!title && $(el).is(selectors.title)) title = $(el).text().trim();
        }

        let link = '';
        if (selectors.link) {
          const parts = selectors.link.split('->').map(s => s.trim());
          const target = parts[0] ? $(el).find(parts[0]) : $(el);
          const attr = parts[1] || 'href';
          link = target.attr(attr) || '';
        }

        if (link && !link.startsWith('http')) {
          try {
            link = new URL(link, this.baseUrl).href;
          } catch (_) {}
        }

        let thumbnail = null;
        if (selectors.thumbnail) {
          const parts = selectors.thumbnail.split('->').map(s => s.trim());
          const target = parts[0] ? $(el).find(parts[0]) : $(el).find('img');
          const attr = parts[1] || 'src';
          thumbnail = target.attr(attr) || target.attr('data-src') || null;
        }

        if (title && link) {
          matches.push(new MatchEntity({
            id: `${this.sourceName}_${i}_${Buffer.from(link).toString('base64url').slice(0, 16)}`,
            title,
            category: this.normalizeCategory(this.defaultCategory),
            date: Date.now().toString(),
            poster: thumbnail,
            sources: [{
              source: this.sourceName,
              id: link,
              url: link
            }]
          }));
        }
      });

      console.log(`[${this.name}] Successfully extracted ${matches.length} dynamic replay matches`);
    } catch (err) {
      console.error(`[${this.name}] Error fetching dynamic matches:`, err.message);
    }

    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    const targetUrl = sourceId.startsWith('http') ? sourceId : `${this.baseUrl}/${sourceId.replace(/^\//, '')}`;

    try {
      const res = await safeFetch(targetUrl, {
        headers: {
          ...this.defaultHeaders,
          'Referer': this.baseUrl
        },
        timeoutMs: 15000,
        attempts: 2
      });

      if (!res.ok) {
        return [new StreamEntity({
          name: this.name,
          title: `${matchTitle || this.name} (Web Player)`,
          externalUrl: targetUrl
        })];
      }

      const html = await res.text();

      // 1. Check for direct M3U8/MP4 streams via built-in extraction chain
      const chainMatch = extractChain(html, this.name);
      if (chainMatch && chainMatch.url) {
        streams.push(new StreamEntity({
          name: this.name,
          title: `${matchTitle || this.name} (Direct Stream)`,
          resolution: '1080p',
          url: chainMatch.url,
          behaviorHints: { notWebReady: false }
        }));
        return streams;
      }

      // 2. Check for OK.ru embed
      const okMatch = html.match(/https?:\/\/(?:www\.)?ok\.ru\/videoembed\/(\d+)/i);
      if (okMatch) {
        streams.push(new StreamEntity({
          name: this.name,
          title: `${matchTitle || this.name} [OK.ru]`,
          externalUrl: okMatch[0]
        }));
        return streams;
      }

      // 3. Check for general video iframes
      const $ = cheerio.load(html);
      const iframes = $('iframe[src]').map((_, el) => $(el).attr('src')).get();
      for (const ifr of iframes) {
        if (/dailymotion|streamwish|byse|sprintcdn|youtube/i.test(ifr)) {
          const finalIfr = ifr.startsWith('//') ? `https:${ifr}` : ifr;
          streams.push(new StreamEntity({
            name: this.name,
            title: `${matchTitle || this.name} (Player)`,
            externalUrl: finalIfr
          }));
          return streams;
        }
      }

      // 4. Default fallback: Web Player at source URL
      streams.push(new StreamEntity({
        name: this.name,
        title: `${matchTitle || this.name} (External Player)`,
        externalUrl: targetUrl
      }));

    } catch (err) {
      console.warn(`[${this.name}] Stream resolution failed for ${sourceId}: ${err.message}`);
      streams.push(new StreamEntity({
        name: this.name,
        title: `${matchTitle || this.name} (Fallback)`,
        externalUrl: targetUrl
      }));
    }

    return streams;
  }
}

module.exports = DynamicCustomProvider;
