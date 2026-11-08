'use strict';

process.env.NODE_ENV = 'test';

const StrumykProvider = require('../src/providers/StrumykProvider');

describe('StrumykProvider', () => {
  const mockFlashscoreText = `
~AA÷Q95hVr0B¬AD÷1794020400¬ADE÷1794020400¬AB÷3¬CR÷3¬AC÷3¬CX÷San Diego Wave W¬RW÷0¬AX÷1¬AO÷1794027950¬BW÷0¬BX÷-1¬WL÷¬WM÷SAN¬PX÷QXU76Jyc¬AE÷San Diego Wave W¬FH÷San Diego Wave W¬JA÷x123¬WU÷san-diego¬GRA÷0¬OA÷logo.png¬WN÷POR¬PY÷p123¬AF÷Portland Thorns W¬FK÷Portland Thorns W¬JB÷y123¬WV÷portland¬GRB÷0¬OB÷logo2.png¬
  `;

  test('getMatches() reconciles Strims24 API items with Flashscore names', async () => {
    const fetchMock = jest.fn((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/football/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            sport: 'football',
            items: [{ match_id: 'FS:Q95hVr0B' }]
          })
        });
      }
      if (urlStr.includes('/api/v1/match/FS%3AQ95hVr0B') || urlStr.includes('/api/v1/match/FS:Q95hVr0B')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            match_id: 'FS:Q95hVr0B',
            custom_urls: [
              { id: 'tok-123', name: 'Stan AU', url: '8411b56a540bb5b7df2a60f51531195a', enabled: true }
            ]
          })
        });
      }
      if (urlStr.includes('/f_1_0_2_en_1')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => mockFlashscoreText
        });
      }
      // Other sports return empty
      if (urlStr.includes('/api/v1/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ items: [] })
        });
      }
      return Promise.resolve({ ok: false, status: 404, text: async () => '' });
    });

    const provider = new StrumykProvider({
      baseUrl: 'https://strims24.st',
      fetchFn: fetchMock
    });

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.id).toBe('strumyk_FS_Q95hVr0B');
    expect(match.title).toBe('San Diego Wave W vs Portland Thorns W');
    expect(match.category).toBe('football');
    expect(match.team1).toEqual({ name: 'San Diego Wave W' });
    expect(match.team2).toEqual({ name: 'Portland Thorns W' });
    expect(match.sources).toHaveLength(1);
    expect(match.sources[0].customUrl).toBe('8411b56a540bb5b7df2a60f51531195a');
    expect(match.sources[0].channelName).toBe('Stan AU');
  });

  test('resolveStream() returns external web player for 32-hex echo token', async () => {
    const provider = new StrumykProvider({
      baseUrl: 'https://strims24.st'
    });

    const streams = await provider.resolveStream('strum_FS_Q95hVr0B_tok-123', 'football', 'San Diego vs Portland', {
      customUrl: '8411b56a540bb5b7df2a60f51531195a',
      channelName: 'Stan AU'
    });

    expect(streams).toHaveLength(1);
    const stream = streams[0];
    expect(stream.name).toBe('Strumyk');
    expect(stream.externalUrl).toBe('/watch?url=' + encodeURIComponent('https://hls.st/echo/8411b56a540bb5b7df2a60f51531195a') + '&title=' + encodeURIComponent('San Diego vs Portland'));
  });

  test('resolveStream() emits direct stream if customUrl is direct m3u8', async () => {
    const provider = new StrumykProvider({
      baseUrl: 'https://strims24.st'
    });

    const streams = await provider.resolveStream('strum_test', 'football', 'Match Live', {
      customUrl: 'https://cdn.example.com/live/index.m3u8',
      channelName: 'Direct Feed'
    });

    expect(streams).toHaveLength(1);
    const stream = streams[0];
    expect(stream.url).toBe('https://cdn.example.com/live/index.m3u8');
    expect(stream.behaviorHints.proxyHeaders.request['Referer']).toBe('https://strims24.st/');
  });
});
