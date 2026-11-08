'use strict';

process.env.NODE_ENV = 'test';

const VipLeagueProvider = require('../src/providers/VipLeagueProvider');

describe('VipLeagueProvider', () => {
  const mockWatchNowHtml = `
    <html>
      <body>
        <details class="col-12 disclosure text-start text-primary" vs-data-events-row>
          <summary class="event-summary" title="Arsenal vs Chelsea">
            <a href="/now-playing/football/arsenal-vs-chelsea" title="Arsenal vs Chelsea" data-bs-target="#1234567" data-no-navigate>
              <i class="align-bottom me-2 vip-league-icon football"></i>
              <time content="2026-11-08T15:00:00+00:00">15:00</time> Arsenal vs Chelsea
            </a>
          </summary>
          <div class="disclosure__content" id="1234567"></div>
        </details>
        <details class="col-12 disclosure text-start text-primary" vs-data-events-row>
          <summary class="event-summary" title="LA Lakers vs Boston Celtics">
            <a href="/now-playing/basketball/lakers-vs-celtics" title="LA Lakers vs Boston Celtics" data-bs-target="#9876543" data-no-navigate>
              <i class="align-bottom me-2 vip-league-icon basketball"></i>
              <time content="2026-11-08T20:30:00+00:00">20:30</time> LA Lakers vs Boston Celtics
            </a>
          </summary>
          <div class="disclosure__content" id="9876543"></div>
        </details>
        <script>
          const siteConfig = {
            "scheduleData": "bGl2ZW5vd3w=",
            "fetck_token": "token123"
          };
        </script>
      </body>
    </html>
  `;

  const mockScheduleApiResponse = {
    links: {
      "1234567": [
        { player: "PlayerA", lang: "English", linkCat: "Link 1", hd: 1 },
        { player: "PlayerB", lang: "Spanish", linkCat: "Link 2", hd: 0 }
      ]
    },
    slugs: {
      "1234567": "arsenal-vs-chelsea",
      "9876543": "lakers-vs-celtics"
    },
    linkAppends: {
      "1234567": "football",
      "9876543": "basketball"
    }
  };

  test('getMatches() scrapes /watch-now and maps schedule links', async () => {
    const fetchMock = jest.fn((url, opts) => {
      if (url.includes('/watch-now')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => mockWatchNowHtml
        });
      }
      if (url.includes('/schedule/')) {
        expect(opts.headers['fetch-token']).toBe('token123');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockScheduleApiResponse
        });
      }
      return Promise.reject(new Error(`Unhandled url: ${url}`));
    });

    const provider = new VipLeagueProvider({
      baseUrl: 'https://vipleague.li',
      fetchFn: fetchMock
    });

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(2);

    const football = matches.find(m => m.id === 'vipleague_1234567');
    expect(football).toBeDefined();
    expect(football.title).toBe('Arsenal vs Chelsea');
    expect(football.category).toBe('football');
    expect(football.team1).toEqual({ name: 'Arsenal' });
    expect(football.team2).toEqual({ name: 'Chelsea' });
    expect(football.sources).toHaveLength(2);
    expect(football.sources[0].viewLivePath).toBe('/view-live/football/arsenal-vs-chelsea-link-1');
    expect(football.sources[0].hd).toBe(true);
    expect(football.sources[1].viewLivePath).toBe('/view-live/football/arsenal-vs-chelsea-link-2');
    expect(football.sources[1].language).toBe('Spanish');

    const basketball = matches.find(m => m.id === 'vipleague_9876543');
    expect(basketball).toBeDefined();
    expect(basketball.category).toBe('basketball');
  });

  test('resolveStream() completes 5-step SecKey handshake and returns direct CDN manifest with proxyHeaders', async () => {
    const mockStreamPageHtml = `
      <html>
        <body>
          <script>
            const siteConfig = {
              "csrf": "csrf_val",
              "csrf_ip": "1.2.3.4",
              "sec_expires": 1794140000,
              "sec_hash": "hash_val"
            };
          </script>
          <script data-pldm="fallafar.me" data-pid="4" data-play="bt287" data-player="jw" data-gc="football"></script>
        </body>
      </html>
    `;

    const secKeyConfig = {
      strUnqId: "stream_bt287",
      sCode: "scode123",
      device_id: "dev_initial",
      session_id: "sess_123",
      edgeHostId: "host_99",
      expireTs: 1794140000,
      csrf_token: Buffer.from("super_secret_auth").toString('base64'),
      secTokenUrl: Buffer.from("https://seckyes.cc/token-api").toString('base64'),
      urlSource: "https://upstream-cdn.space/live/manifest.m3u8?stream=bt287&u_id=dev_initial",
      tokenName: "X-CSRF-Auth",
      tokenName_2: "Accept",
      tokenValue_2: "application/json"
    };

    const mockEmbedHtml = `
      <html>
        <body>
          <script>
            window.SecKeyPlayerConfig = {};
            window.SecKeyPlayerConfig["bt287"] = ${JSON.stringify(secKeyConfig)};
          </script>
        </body>
      </html>
    `;

    const fetchMock = jest.fn((url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/view-live/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => mockStreamPageHtml
        });
      }
      if (urlStr.includes('fallafar.me/sd0embed/')) {
        expect(opts.headers.Referer).toContain('vipleague.li');
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => mockEmbedHtml
        });
      }
      if (urlStr.includes('seckyes.cc/token-api')) {
        expect(opts.headers['X-CSRF-Auth']).toBe('super_secret_auth');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            device_id: "authenticated_dev_id_777"
          })
        });
      }
      return Promise.reject(new Error(`Unhandled fetch: ${urlStr}`));
    });

    const provider = new VipLeagueProvider({
      baseUrl: 'https://vipleague.li',
      fetchFn: fetchMock
    });

    const streams = await provider.resolveStream('vip_1234567_1', 'football', 'Arsenal vs Chelsea', {
      viewLivePath: '/view-live/football/arsenal-vs-chelsea-link-1',
      linkNo: 1,
      channelName: 'Stream 1',
      language: 'English',
      hd: true
    });

    expect(streams).toHaveLength(1);
    const stream = streams[0];
    expect(stream.name).toBe('VIPLeague');
    expect(stream.title).toContain('Arsenal vs Chelsea');
    expect(stream.resolution).toBe('HD');

    // Direct playback url with updated device_id
    expect(stream.url).toBe('https://upstream-cdn.space/live/manifest.m3u8?stream=bt287&u_id=authenticated_dev_id_777');
    
    // Zero Server Bandwidth Bleed verification: must provide proxyHeaders directly to player
    expect(stream.behaviorHints).toBeDefined();
    expect(stream.behaviorHints.proxyHeaders.request['Referer']).toBe('https://fallafar.me/');
    expect(stream.behaviorHints.proxyHeaders.request['X-CSRF-Auth']).toBe('super_secret_auth');
    expect(stream.url).not.toContain('/api/hlschunk');
    expect(stream.url).not.toContain('/api/fastmp4');
  });

  test('resolveStream() falls back to web player on network or upstream challenge error', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new Error('Upstream Cloudflare Challenge')));

    const provider = new VipLeagueProvider({
      baseUrl: 'https://vipleague.li',
      fetchFn: fetchMock
    });

    const streams = await provider.resolveStream('vip_1234567_1', 'football', 'Arsenal vs Chelsea', {
      viewLivePath: '/view-live/football/arsenal-vs-chelsea-link-1'
    });

    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toBe('/watch?url=' + encodeURIComponent('https://vipleague.li/view-live/football/arsenal-vs-chelsea-link-1') + '&title=' + encodeURIComponent('Arsenal vs Chelsea'));
  });
});
