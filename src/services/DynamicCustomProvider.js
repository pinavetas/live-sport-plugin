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
            isCustomAi: true,
            customAiSource: this.sourceName,
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

  /**
   * Deep Multi-Hop Stream Resolution:
   * 1. Navigates to match detail landing page.
   * 2. Detects embedded SPA links (e.g. FootyBite/SoccerStreams) and server buttons.
   * 3. Explores stream hosts concurrently to locate direct M3U8 HLS streams,
   *    DaddyLive stream channels, or embed players.
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    const targetUrl = sourceId.startsWith('http') ? sourceId : `${this.baseUrl}/${sourceId.replace(/^\//, '')}`;
    const container = require('../container');

    try {
      const res = await safeFetch(targetUrl, {
        headers: {
          ...this.defaultHeaders,
          'Referer': this.baseUrl
        },
        timeoutMs: 12000,
        attempts: 2
      });

      if (!res.ok) {
        return [new StreamEntity({
          name: this.name,
          title: `${matchTitle || this.name} (Source Web Player)`,
          externalUrl: targetUrl
        })];
      }

      const html = await res.text();

      // Hop 1 Check: Direct M3U8 on match landing page
      const directChain = extractChain(html, this.name);
      if (directChain && directChain.url) {
        return [new StreamEntity({
          name: this.name,
          title: `${matchTitle || this.name} [Direct Stream]`,
          resolution: '1080p',
          url: directChain.url,
          score: 100,
          behaviorHints: { notWebReady: false }
        })];
      }

      // Hop 2: Discover stream servers/links on the match page
      const streamCandidates = [];

      // A. Check for SPA embedded links (e.g. FootyBite / SoccerStreams ftbPageData.schedule)
      const ftbMatch = html.match(/window\.ftbPageData\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|\n|<\/script>)/);
      if (ftbMatch) {
        try {
          const fn = new Function('return ' + ftbMatch[1]);
          const data = fn();
          const sched = data && data.schedule ? data.schedule : {};
          for (const g of Object.values(sched)) {
            if (g && g.links) {
              const links = typeof g.links === 'string' ? JSON.parse(g.links) : g.links;
              if (Array.isArray(links)) {
                for (const l of links) {
                  if (l && l.url) {
                    streamCandidates.push({
                      name: l.name || 'Stream Server',
                      url: l.url.trim(),
                      quality: l.quality || 'HD'
                    });
                  }
                }
              }
            }
          }
        } catch (_) {}
      }

      // B. Custom or heuristic DOM scan for stream links/buttons
      const $ = cheerio.load(html);
      const customSelector = this.config.selectors && this.config.selectors.streamLinks;
      if (customSelector) {
        $(customSelector).each((_, el) => {
          const href = $(el).attr('href');
          const title = $(el).text().trim();
          if (href) {
            try {
              streamCandidates.push({
                name: title || 'Stream',
                url: new URL(href, targetUrl).href,
                quality: 'HD'
              });
            } catch (_) {}
          }
        });
      }

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (/stream|watch|live|play|server|channel/i.test(href) &&
            !href.startsWith('#') && !href.includes('/sports/') && !href.includes('/league/')) {
          try {
            const fullUrl = new URL(href, targetUrl).href;
            if (!streamCandidates.some(s => s.url === fullUrl)) {
              streamCandidates.push({
                name: text || 'Stream Server',
                url: fullUrl,
                quality: 'HD'
              });
            }
          } catch (_) {}
        }
      });

      // C. Direct iframes on match landing page
      $('iframe[src]').each((_, el) => {
        const srcAttr = $(el).attr('src') || '';
        if (srcAttr && !srcAttr.startsWith('#')) {
          try {
            const fullIfr = new URL(srcAttr, targetUrl).href;
            if (!streamCandidates.some(s => s.url === fullIfr)) {
              streamCandidates.push({
                name: 'Player Iframe',
                url: fullIfr,
                quality: 'HD',
                isIframe: true
              });
            }
          } catch (_) {}
        }
      });

      // Hop 3: Deep Multi-Hop inspection across top stream candidates
      const hopTargets = streamCandidates.slice(0, 6);
      if (hopTargets.length > 0) {
        const hopPromises = hopTargets.map(async (candidate, idx) => {
          try {
            // Check if candidate URL is directly a DaddyLive channel
            const dliveMatch = candidate.url.match(/stream-(\d+)\.php/i);
            if (dliveMatch) {
              const channelId = dliveMatch[1];
              try {
                const daddyLiveProvider = container.resolve('daddyLiveProvider');
                if (daddyLiveProvider) {
                  const resolved = await daddyLiveProvider.resolveStream(channelId, matchCategory, matchTitle);
                  if (resolved && resolved.length > 0) {
                    return resolved.map(st => new StreamEntity({
                      ...st,
                      name: `${this.name} [${candidate.name}]`,
                      title: `${matchTitle || this.name} - ${candidate.name} (Direct HLS)`,
                      score: 95 - idx
                    }));
                  }
                }
              } catch (_) {}
            }

            // Fetch candidate stream host page
            const hopRes = await safeFetch(candidate.url, {
              headers: {
                ...this.defaultHeaders,
                'Referer': targetUrl
              },
              timeoutMs: 5000,
              attempts: 1
            });

            if (!hopRes.ok) return null;
            const hopHtml = await hopRes.text();

            // Direct M3U8 on stream host page
            const hopChain = extractChain(hopHtml, this.name);
            if (hopChain && hopChain.url) {
              return [new StreamEntity({
                name: `${this.name} [${candidate.name}]`,
                title: `${matchTitle || this.name} - ${candidate.name} (Direct Stream)`,
                url: hopChain.url,
                resolution: '1080p',
                score: 90 - idx,
                behaviorHints: { notWebReady: false }
              })];
            }

            // Nested iframes inspection
            const $hop = cheerio.load(hopHtml);
            const nestedIframes = $hop('iframe[src]').map((_, el) => $hop(el).attr('src')).get();

            for (const ifr of nestedIframes) {
              const nestedDlive = ifr.match(/stream-(\d+)\.php/i);
              if (nestedDlive) {
                const channelId = nestedDlive[1];
                try {
                  const daddyLiveProvider = container.resolve('daddyLiveProvider');
                  if (daddyLiveProvider) {
                    const resolved = await daddyLiveProvider.resolveStream(channelId, matchCategory, matchTitle);
                    if (resolved && resolved.length > 0) {
                      return resolved.map(st => new StreamEntity({
                        ...st,
                        name: `${this.name} [${candidate.name}]`,
                        title: `${matchTitle || this.name} - ${candidate.name} (Direct HLS)`,
                        score: 95 - idx
                      }));
                    }
                  }
                } catch (_) {}
              }

              // Fetch player iframe to extract M3U8
              try {
                const ifrFull = ifr.startsWith('//') ? `https:${ifr}` : (ifr.startsWith('http') ? ifr : new URL(ifr, candidate.url).href);
                const ifrRes = await safeFetch(ifrFull, {
                  headers: { ...this.defaultHeaders, 'Referer': candidate.url },
                  timeoutMs: 4000,
                  attempts: 1
                });
                if (ifrRes.ok) {
                  const ifrText = await ifrRes.text();
                  const ifrChain = extractChain(ifrText, this.name);
                  if (ifrChain && ifrChain.url) {
                    return [new StreamEntity({
                      name: `${this.name} [${candidate.name}]`,
                      title: `${matchTitle || this.name} - ${candidate.name} (Direct Stream)`,
                      url: ifrChain.url,
                      resolution: '1080p',
                      score: 88 - idx,
                      behaviorHints: { notWebReady: false }
                    })];
                  }
                }
              } catch (_) {}
            }

            // Fallback: Embed server player
            return [new StreamEntity({
              name: `${this.name} [${candidate.name}]`,
              title: `${matchTitle || this.name} - ${candidate.name} (Server Player)`,
              externalUrl: candidate.url,
              score: 50 - idx
            })];
          } catch (_) {
            return null;
          }
        });

        const settledHops = await Promise.allSettled(hopPromises);
        for (const r of settledHops) {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            streams.push(...r.value);
          }
        }
      }

      // Prioritize streams with direct playable URLs over external links
      if (streams.length > 0) {
        streams.sort((a, b) => (b.url ? 1 : 0) - (a.url ? 1 : 0));
        return streams;
      }

      return [new StreamEntity({
        name: this.name,
        title: `${matchTitle || this.name} (External Player)`,
        externalUrl: targetUrl
      })];

    } catch (err) {
      console.warn(`[${this.name}] Stream resolution failed for ${sourceId}: ${err.message}`);
      return [new StreamEntity({
        name: this.name,
        title: `${matchTitle || this.name} (Fallback)`,
        externalUrl: targetUrl
      })];
    }
  }
}

module.exports = DynamicCustomProvider;
