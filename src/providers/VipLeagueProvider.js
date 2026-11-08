'use strict';

/**
 * VipLeagueProvider.js
 *
 * Dedicated live sports provider for VIPLeague network (vipleague.li).
 * Features:
 * - Dynamic scraping of /watch-now schedule with schedule API token exchange
 * - Full SecKey player handshake resolving direct upstream AES-128 HLS manifests
 * - Direct upstream CDN playback with proxyHeaders (Zero Server Bandwidth Bleed Policy)
 * - Safe web player fallback when upstream requires interactive challenge
 */

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

class VipLeagueProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'VIPLeague';
    this.sourceName = 'vipleague';

    let customBase = null;
    let customFetch = null;
    let cb = null;
    try {
      if (opts && typeof opts === 'object') {
        if (Object.prototype.hasOwnProperty.call(opts, 'baseUrl')) customBase = opts.baseUrl;
        if (Object.prototype.hasOwnProperty.call(opts, 'fetchFn')) customFetch = opts.fetchFn;
        if (Object.prototype.hasOwnProperty.call(opts, 'circuitBreaker')) cb = opts.circuitBreaker;
      }
    } catch (_) {}

    this.baseUrl = (customBase || process.env.VIPLEAGUE_BASE_URL || 'https://vipleague.li').replace(/\/+$/, '');
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

  async _getMatchesInternal() {
    const matches = [];
    try {
      const scheduleUrl = `${this.baseUrl}/watch-now`;
      const res = await this.fetchFn(scheduleUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        console.warn(`[${this.name}] /watch-now returned status ${res.status}`);
        return matches;
      }

      const html = await res.text();

      // Extract siteConfig for schedule POST token
      const cfgMatch = html.match(/const siteConfig\s*=\s*({[^;]+});/);
      let scheduleMap = { links: {}, slugs: {}, linkAppends: {} };

      if (cfgMatch) {
        try {
          const cfg = JSON.parse(cfgMatch[1]);
          const scheduleData = cfg.scheduleData;
          const fetchToken = cfg.fetck_token || cfg.fetch_token;

          if (scheduleData && fetchToken) {
            const postUrl = `${this.baseUrl}/schedule/${encodeURIComponent(scheduleData)}/`;
            const postRes = await this.fetchFn(postUrl, {
              method: 'POST',
              headers: {
                'User-Agent': UA,
                'Referer': scheduleUrl,
                'Origin': this.baseUrl,
                'Content-Type': 'application/json',
                'fetch-token': fetchToken
              },
              signal: AbortSignal.timeout(8000)
            });

            if (postRes.ok) {
              const data = await postRes.json();
              if (data && typeof data === 'object') {
                scheduleMap = {
                  links: data.links || {},
                  slugs: data.slugs || {},
                  linkAppends: data.linkAppends || {}
                };
              }
            }
          }
        } catch (e) {
          console.warn(`[${this.name}] schedule API call failed:`, e.message);
        }
      }

      // Parse event rows: <details class="... disclosure ..." vs-data-events-row>...</details>
      const rowRegex = /<details[^>]*vs-data-events-row[^>]*>([\s\S]*?)<\/details>/gi;
      let rowMatch;

      while ((rowMatch = rowRegex.exec(html)) !== null) {
        const rowHtml = rowMatch[1];

        // Target / Event ID
        const targetMatch = rowHtml.match(/data-bs-target="#([0-9]+)"/);
        if (!targetMatch) continue;
        const eventId = targetMatch[1];

        // Title and sport
        const summaryTitleMatch = rowHtml.match(/<summary[^>]*title="([^"]+)"/i);
        const anchorMatch = rowHtml.match(/<a[^>]*href="(\/now-playing\/([^"/]+)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

        let rawTitle = '';
        let sport = 'other';
        let nowPlayingPath = '';

        if (anchorMatch) {
          nowPlayingPath = anchorMatch[1];
          sport = anchorMatch[2];
          rawTitle = anchorMatch[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        } else if (summaryTitleMatch) {
          rawTitle = summaryTitleMatch[1].trim();
        }

        if (!rawTitle && summaryTitleMatch) {
          rawTitle = summaryTitleMatch[1].trim();
        }

        // Clean any leading time string or icon artefacts from title
        rawTitle = rawTitle.replace(/^\d{1,2}:\d{2}\s*/, '').trim();
        if (!rawTitle) continue;

        // Kickoff time
        const timeMatch = rowHtml.match(/<time[^>]*content="([^"]+)"/i);
        const isoTime = timeMatch ? timeMatch[1] : '';
        const kickoffMs = isoTime ? new Date(isoTime).getTime() : 0;

        // Sport classification from icon if needed
        const iconMatch = rowHtml.match(/vip-league-icon\s+([a-z0-9_-]+)/i);
        if (iconMatch && (!sport || sport === 'other')) {
          sport = iconMatch[1];
        }

        const category = this.normalizeCategory(sport);
        const teams = extractTeamsFromTitle(rawTitle);

        const sources = [];
        const eventLinks = scheduleMap.links[eventId];
        const slug = scheduleMap.slugs[eventId] || '';
        const linkCat = scheduleMap.linkAppends[eventId] || sport;

        if (Array.isArray(eventLinks) && eventLinks.length > 0) {
          eventLinks.forEach((link, idx) => {
            const linkNo = idx + 1;
            const viewLivePath = slug ? `/view-live/${encodeURIComponent(linkCat)}/${encodeURIComponent(slug)}-link-${linkNo}` : '';
            sources.push({
              source: this.sourceName,
              id: `vip_${eventId}_${linkNo}`,
              eventId,
              linkNo,
              slug,
              linkCat,
              viewLivePath,
              channelName: link.linkCat || `Stream ${linkNo}`,
              player: link.player || '',
              language: link.lang || '',
              hd: link.hd === 1
            });
          });
        } else {
          // Fallback source if schedule mapping is absent
          sources.push({
            source: this.sourceName,
            id: `vip_${eventId}_1`,
            eventId,
            linkNo: 1,
            slug,
            linkCat,
            viewLivePath: nowPlayingPath,
            channelName: 'VIPLeague Stream 1',
            hd: false
          });
        }

        matches.push(new MatchEntity({
          id: `vipleague_${eventId}`,
          title: rawTitle,
          baseTitle: rawTitle,
          category,
          date: kickoffMs > 0 ? String(kickoffMs) : '0',
          status: (kickoffMs > 0 && kickoffMs > Date.now()) ? 'upcoming' : 'live',
          team1: teams ? { name: teams[0] } : null,
          team2: teams ? { name: teams[1] } : null,
          sources
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to fetch matches:`, err.message);
    }

    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];

    let viewLivePath = src.viewLivePath;
    if (!viewLivePath && src.slug && src.linkCat && src.linkNo) {
      viewLivePath = `/view-live/${encodeURIComponent(src.linkCat)}/${encodeURIComponent(src.slug)}-link-${src.linkNo}`;
    }

    if (!viewLivePath) {
      console.warn(`[${this.name}] No viewLivePath for ${sourceId}`);
      return streams;
    }

    const pageUrl = viewLivePath.startsWith('http') ? viewLivePath : `${this.baseUrl}${viewLivePath}`;

    try {
      // 1. Fetch stream page
      const pageRes = await this.fetchFn(pageUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': `${this.baseUrl}/`,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!pageRes.ok) throw new Error(`Stream page returned ${pageRes.status}`);
      const pageHtml = await pageRes.text();

      // Extract siteConfig
      const cfgMatch = pageHtml.match(/const siteConfig\s*=\s*({[^;]+});/);
      if (!cfgMatch) throw new Error('Missing siteConfig on stream page');
      const cfg = JSON.parse(cfgMatch[1]);

      // Extract embed script attributes
      const scriptMatch = pageHtml.match(/<script[^>]+data-pldm="([^"]+)"[^>]+data-pid="([^"]+)"[^>]+data-play="([^"]+)"[^>]+data-player="([^"]+)"[^>]+data-gc="([^"]+)"/i)
        || pageHtml.match(/data-pldm="([^"]+)"[^>]*data-pid="([^"]+)"[^>]*data-play="([^"]+)"[^>]*data-player="([^"]+)"[^>]*data-gc="([^"]+)"/i);

      if (!scriptMatch) throw new Error('Missing embed parameters on stream page');

      const [, pldm, pid, play, player, gc] = scriptMatch;

      // 2. Fetch embed page
      const embedUrl = new URL(`https://${pldm}/sd0embed/${encodeURIComponent(gc)}`);
      embedUrl.search = new URLSearchParams({
        pid,
        v: play,
        player,
        csrf: cfg.csrf || '',
        csrf_ip: cfg.csrf_ip || '',
        expires: String(cfg.sec_expires || ''),
        sec_hash: cfg.sec_hash || ''
      }).toString();

      const embedRes = await this.fetchFn(embedUrl.href, {
        headers: {
          'User-Agent': UA,
          'Referer': pageUrl,
          'Origin': this.baseUrl,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!embedRes.ok) throw new Error(`Embed page returned ${embedRes.status}`);
      const embedHtml = await embedRes.text();

      // 3. Extract SecKeyPlayerConfig
      const secMatch = embedHtml.match(/window\.SecKeyPlayerConfig\["[^"]+"\]\s*=\s*({[^;]+});/);
      if (!secMatch) throw new Error('Missing SecKeyPlayerConfig in embed HTML');
      const secCfg = JSON.parse(secMatch[1]);

      if (!secCfg.secTokenUrl || !secCfg.urlSource) throw new Error('Invalid SecKeyPlayerConfig attributes');

      const tokenUrl = Buffer.from(secCfg.secTokenUrl, 'base64').toString('utf8');
      const authHeader = Buffer.from(secCfg.csrf_token || '', 'base64').toString('binary');

      const tokenReqUrl = new URL(tokenUrl);
      tokenReqUrl.searchParams.set('scode', secCfg.sCode || '');
      tokenReqUrl.searchParams.set('stream', secCfg.strUnqId || '');
      tokenReqUrl.searchParams.set('expires', String(secCfg.expireTs || ''));
      tokenReqUrl.searchParams.set('u_id', secCfg.device_id || '');
      tokenReqUrl.searchParams.set('session_id', secCfg.session_id || '');
      tokenReqUrl.searchParams.set('host_id', secCfg.edgeHostId || '');

      const tokenHeaderName = secCfg.tokenName || 'X-CSRF-Auth';
      const tokenHeaderName2 = secCfg.tokenName_2 || 'Accept';
      const tokenValue2 = secCfg.tokenValue_2 || 'application/json';

      // 4. Token exchange
      const tokenRes = await this.fetchFn(tokenReqUrl.href, {
        headers: {
          'User-Agent': UA,
          'Referer': `https://${pldm}/`,
          'Origin': `https://${pldm}`,
          [tokenHeaderName]: authHeader,
          [tokenHeaderName2]: tokenValue2
        },
        signal: AbortSignal.timeout(6000)
      });

      let authenticatedUid = secCfg.device_id;
      if (tokenRes.ok) {
        try {
          const tokenData = await tokenRes.json();
          if (tokenData && tokenData.device_id) {
            authenticatedUid = tokenData.device_id;
          }
        } catch (_) {}
      }

      // 5. Build final direct manifest URL
      const streamManifestUrl = new URL(secCfg.urlSource);
      if (authenticatedUid) {
        streamManifestUrl.searchParams.set('u_id', authenticatedUid);
      }

      const langSuffix = src.language ? ` [${src.language.toUpperCase()}]` : '';
      const qualityLabel = src.hd ? 'HD' : 'SD';

      streams.push(new StreamEntity({
        name: this.name,
        title: `${this.name} - ${src.channelName || `Stream ${src.linkNo || 1}`}${langSuffix} (${matchTitle || 'Live'})`,
        url: streamManifestUrl.href,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': UA,
              'Referer': `https://${pldm}/`,
              'Origin': `https://${pldm}`,
              [tokenHeaderName]: authHeader
            }
          }
        },
        resolution: qualityLabel
      }));
    } catch (err) {
      console.warn(`[${this.name}] Manifest resolution failed for ${sourceId}:`, err.message);
    }

    // Fallback: Web player embed
    if (streams.length === 0) {
      streams.push(new StreamEntity({
        name: this.name,
        title: `${this.name} (Web Player) - ${src.channelName || matchTitle || 'Live'}`,
        externalUrl: `/watch?url=${encodeURIComponent(pageUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
      }));
    }

    return streams;
  }
}

module.exports = VipLeagueProvider;
