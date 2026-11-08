'use strict';

const SpaHydrator = require('../src/services/SpaHydrator');

describe('SpaHydrator - Client-Side Rendered (SPA) Virtual DOM Hydration', () => {
  test('hydrates FootyBite / SoccerStreams window.ftbPageData schedule into static DOM match cards', () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="ft-app js-ft-app" data-page="sports">
            <section class="ft-sch js-main-content">
              <div class="ft-loader js-ft-loader"><p>Loading schedule...</p></div>
            </section>
          </div>
          <script>
            window.ftbPageData = {
              sports: {"id":3,"name":"Football","desc":"football","slug":"football"},
              schedule: [
                {"id":1001,"sports_id":3,"league_id":50,"name":"Arsenal vs Chelsea","start":"1792621800"},
                {"id":1002,"sports_id":3,"league_id":50,"name":"Real Madrid vs Barcelona","start":"1792625400"}
              ]
            };
          </script>
        </body>
      </html>
    `;

    const hydrated = SpaHydrator.hydrate(rawHtml, 'https://soccerstreams100.im/sports/football/');
    expect(hydrated).toContain('ft-sch-game-item');
    expect(hydrated).toContain('Arsenal vs Chelsea');
    expect(hydrated).toContain('/sports/football/arsenal-vs-chelsea/1001/');
    expect(hydrated).toContain('Real Madrid vs Barcelona');
    expect(hydrated).toContain('/sports/football/real-madrid-vs-barcelona/1002/');
  });

  test('hydrates Next.js __NEXT_DATA__ script into static DOM match cards', () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <div id="__next"><div>Loading...</div></div>
          <script id="__NEXT_DATA__" type="application/json">
            {
              "props": {
                "pageProps": {
                  "matches": [
                    { "id": "m1", "title": "Lakers vs Warriors", "url": "/watch/lakers-warriors" },
                    { "id": "m2", "title": "Celtics vs Heat", "url": "/watch/celtics-heat" }
                  ]
                }
              }
            }
          </script>
        </body>
      </html>
    `;

    const hydrated = SpaHydrator.hydrate(rawHtml, 'https://next-replays.com');
    expect(hydrated).toContain('next-match-card');
    expect(hydrated).toContain('Lakers vs Warriors');
    expect(hydrated).toContain('/watch/lakers-warriors');
    expect(hydrated).toContain('Celtics vs Heat');
  });

  test('leaves standard SSR HTML untouched', () => {
    const rawHtml = `
      <div class="videos">
        <article class="post-item">
          <h2><a href="/f1-monaco">F1 Monaco 2026</a></h2>
        </article>
      </div>
    `;

    const hydrated = SpaHydrator.hydrate(rawHtml);
    expect(hydrated).toBe(rawHtml);
  });

  test('handles null, empty, and malformed inputs gracefully without throwing', () => {
    expect(SpaHydrator.hydrate('')).toBe('');
    expect(SpaHydrator.hydrate(null)).toBe('');
    expect(SpaHydrator.hydrate('<script>window.ftbPageData = invalid-syntax;</script>')).toContain('window.ftbPageData');
  });
});

describe('SpaHydrator - escapes scraped values in synthesized HTML', () => {
  const cheerio = require('cheerio');

  test('ftbPageData titles with quotes and markup stay text, not markup', () => {
    const rawHtml = `<html><body><section class="ft-sch"></section><script>
      window.ftbPageData = {
        sports: {"slug":"football"},
        schedule: [{"id":"7\\" onclick=\\"x","name":"Say \\"Hi\\" <b>bold</b> & co","start":"<i>1</i>"}]
      };
    </script></body></html>`;

    const $ = cheerio.load(SpaHydrator.hydrate(rawHtml));
    const card = $('.ft-sch-game-item');
    expect(card).toHaveLength(1);
    expect(card.attr('data-id')).toBe('7" onclick="x');
    expect(card.attr('onclick')).toBeUndefined();
    expect(card.find('.match-title').text()).toBe('Say "Hi" <b>bold</b> & co');
    expect(card.find('b')).toHaveLength(0);
    expect(card.find('i')).toHaveLength(0);
    expect(card.find('.match-time').text()).toBe('<i>1</i>');
  });

  test('__NEXT_DATA__ title/link/poster/id with quotes and markup cannot break attributes', () => {
    const payload = {
      props: {
        pageProps: {
          matches: [{
            id: 'm"1',
            title: 'A "quoted" <b>title</b>',
            url: '/watch/a" onmouseover="alert(1)',
            poster: 'https://img.test/p.jpg" onerror="alert(1)',
          }],
        },
      },
    };
    const rawHtml = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;

    const $ = cheerio.load(SpaHydrator.hydrate(rawHtml));
    const card = $('.next-match-card');
    expect(card).toHaveLength(1);
    expect(card.attr('data-id')).toBe('m"1');
    expect(card.find('.match-title').text()).toBe('A "quoted" <b>title</b>');
    expect(card.find('b')).toHaveLength(0);
    const a = card.find('a.match-link');
    expect(a.attr('href')).toBe('/watch/a" onmouseover="alert(1)');
    expect(a.attr('onmouseover')).toBeUndefined();
    const img = card.find('img.match-poster');
    expect(img.attr('src')).toBe('https://img.test/p.jpg" onerror="alert(1)');
    expect(img.attr('onerror')).toBeUndefined();
  });
});
