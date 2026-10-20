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
