/**
 * SpaHydrator.js - Client-Side Rendered (SPA) Virtual DOM Hydration
 *
 * Many modern sports streaming & replay websites (like SoccerStreams, FootyBite,
 * and Next.js/Nuxt SPAs) send an initial HTML document containing an empty loader
 * skeleton (e.g. "<p>Loading schedule...</p>") while embedding the full match schedule
 * inside an inline <script> state object (e.g. window.ftbPageData or __NEXT_DATA__).
 *
 * Cheerio cannot execute client-side JavaScript, so selectors run against raw HTML
 * would find 0 elements. SpaHydrator detects embedded state and synthesizes standard
 * HTML match cards into the DOM so that Cheerio selectors and AI scrapers work seamlessly.
 */

'use strict';

const cheerio = require('cheerio');
const { parseJsLiteral } = require('./safeJsLiteral');

// Scraped values are interpolated into synthesized HTML; escape them so quotes or
// markup in a title/link cannot break out of the attribute or inject elements.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

class SpaHydrator {
  /**
   * Hydrates embedded SPA script state into static DOM match elements.
   * If the page is standard SSR HTML, it is returned untouched.
   *
   * @param {string} rawHtml
   * @param {string} [baseUrl]
   * @returns {string} Hydrated HTML
   */
  static hydrate(rawHtml, baseUrl = '') {
    if (!rawHtml || typeof rawHtml !== 'string') return '';

    let hydratedHtml = rawHtml;

    // Pattern 1: FootyBite / SoccerStreams SPA family (window.ftbPageData = { schedule: [...] })
    const ftbMatch = rawHtml.match(/window\.ftbPageData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (ftbMatch) {
      try {
        // Literal-only evaluation: the payload is third-party HTML, never execute it.
        const data = parseJsLiteral(ftbMatch[1]);
        if (data && Array.isArray(data.schedule) && data.schedule.length > 0) {
          const sportsSlug = data.sports && data.sports.slug 
            ? String(data.sports.slug).replace(/-sports$/, '') 
            : 'sports';

          const synthesizedCards = data.schedule.map(g => {
            const rawName = String(g.name || '').replace(/\p{Emoji}/gu, '').trim();
            const gameSlug = rawName
              .replace(/[^\w\s-]/g, '')
              .replace(/-/g, ' ')
              .replace(/\s+/g, '-')
              .toLowerCase();
            const link = `/sports/${sportsSlug}/${gameSlug}/${g.id}/`;

            return `
              <div class="match-item ft-sch-game-item" data-id="${esc(g.id)}">
                <a href="${esc(link)}" class="match-link">
                  <span class="match-title">${esc(rawName)}</span>
                  <span class="match-time">${esc(g.start || '')}</span>
                </a>
              </div>
            `;
          }).join('\n');

          const $ = cheerio.load(hydratedHtml);
          if ($('.ft-sch, .js-main-content, .ft-main').length) {
            $('.ft-sch, .js-main-content, .ft-main').first().append(synthesizedCards);
          } else {
            $('body').append(`<div class="ft-sch js-main-content">${synthesizedCards}</div>`);
          }
          hydratedHtml = $.html();
        }
      } catch (_) {}
    }

    // Pattern 2: Next.js __NEXT_DATA__ state
    const nextDataMatch = rawHtml.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextJson = JSON.parse(nextDataMatch[1]);
        const props = nextJson.props && nextJson.props.pageProps;
        if (props) {
          for (const [key, val] of Object.entries(props)) {
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && (val[0].title || val[0].name)) {
              const cards = val.map((item, i) => {
                const title = item.title || item.name || '';
                const link = item.url || item.link || item.slug || item.href || '#';
                const poster = item.poster || item.thumbnail || item.image || '';
                return `
                  <div class="match-item next-match-card" data-id="${esc(item.id || i)}">
                    <a href="${esc(link)}" class="match-link">
                      <span class="match-title">${esc(title)}</span>
                      ${poster ? `<img src="${esc(poster)}" class="match-poster" />` : ''}
                    </a>
                  </div>
                `;
              }).join('\n');

              const $ = cheerio.load(hydratedHtml);
              $('body').append(`<div class="next-matches-container">${cards}</div>`);
              hydratedHtml = $.html();
              break;
            }
          }
        }
      } catch (_) {}
    }

    return hydratedHtml;
  }
}

module.exports = SpaHydrator;
