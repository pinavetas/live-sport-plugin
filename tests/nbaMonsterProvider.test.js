'use strict';

process.env.NODE_ENV = 'test';

const NbaMonsterProvider = require('../src/providers/NbaMonsterProvider');
const MatchAggregator = require('../src/services/MatchAggregator');
const { extractIframeSrc } = NbaMonsterProvider;
const feed = require('./fixtures/providers/nbamonster-live.json');

const passthroughBreaker = {
  wrap: (name, fn) => ({ fire: fn }),
  wrapSync: (name, fn) => ({ fire: fn })
};

// Denver @ Indiana tips off at 22:00Z (1794088800000), Brooklyn @ Atlanta at 00:30Z.
const PRE_GAME = 1794085000000;
const DURING_FIRST = 1794090000000;

// Trimmed real smartplayer wrapper (the real page also carries a ~650 KB
// obfuscated blob after the iframe).
const SMARTPLAYER_TAIFOOD = `<!DOCTYPE html><html lang="en"><head><title>Stream Player</title></head><body>
<div id="ld"><div>Loading stream...</div></div>
<div style="width:100%;height:100%"><iframe id="p3bddd71709a5" src="https://taifood-blog.asia/embed/nba/2026-11-07/den-ind" allowfullscreen="true" referrerpolicy="origin"></iframe></div>
<script>window['ZpQw9XkLmN8c3vR3']='A3BYEDFXAjpT';</script></body></html>`;
const SMARTPLAYER_OTHER = '<html><body><iframe src="/relay/embed.php?ch=es105&amp;hd=1"></iframe></body></html>';
const EMBED_WITH_M3U8 = '<script>var src="https://cdn.example.net/live/es105/index.m3u8?token=xyz";</script>';

function makeProvider(extra = {}) {
  return new NbaMonsterProvider({ circuitBreaker: passthroughBreaker, ...extra });
}

describe('NbaMonsterProvider.extractIframeSrc', () => {
  test('reads the first iframe and resolves relative URLs / entities', () => {
    expect(extractIframeSrc(SMARTPLAYER_TAIFOOD, 'https://piratecat.store/smartplayer.php?hd=x')).toBe('https://taifood-blog.asia/embed/nba/2026-11-07/den-ind');
    expect(extractIframeSrc(SMARTPLAYER_OTHER, 'https://piratecat.store/smartplayer.php?hd=x')).toBe('https://piratecat.store/relay/embed.php?ch=es105&hd=1');
    expect(extractIframeSrc('<div>Access Denied</div>', 'https://piratecat.store/')).toBeNull();
    expect(extractIframeSrc('<iframe src="javascript:alert(1)"></iframe>', 'https://piratecat.store/')).toBeNull();
  });
});

describe('NbaMonsterProvider.parseFeed', () => {
  test('maps upcoming games with teams, logos, kickoff and one source per link', () => {
    const p = makeProvider();
    const games = p.parseFeed(feed, PRE_GAME).filter(m => m.category === 'basketball');
    expect(games).toHaveLength(2);
    const den = games[0];
    expect(den).toMatchObject({
      id: 'nbamonster_401909938',
      title: 'Denver Nuggets @ Indiana Pacers',
      league: 'NBA',
      status: 'upcoming',
      date: '1794088800000'
    });
    expect(den.team1).toEqual({ name: 'Denver Nuggets', logo: 'https://nbamonster.com/uploads/9e555cba90fcf5d48bdc.png' });
    expect(den.team2.name).toBe('Indiana Pacers');
    expect(den.sources).toHaveLength(7);
    expect(den.sources[0]).toMatchObject({ source: 'nbamonster', channelName: 'Link 1', url: 'https://piratecat.store/smartplayer.php?hd=indiana-pacers=ch01' });
    expect(Buffer.from(den.sources[0].id, 'base64url').toString()).toBe(den.sources[0].url);
  });

  test('flags a game live once it tips off and drops finished games', () => {
    const p = makeProvider();
    const during = p.parseFeed(feed, DURING_FIRST).filter(m => m.category === 'basketball');
    expect(during.find(m => m.id === 'nbamonster_401909938').status).toBe('live');
    expect(during.find(m => m.id === 'nbamonster_401909939').status).toBe('upcoming');

    const finished = { live_games: [{ ...feed.live_games[0], espn_state: 'post', espn_completed: true }] };
    expect(p.parseFeed(finished, DURING_FIRST)).toEqual([]);
    const pastEnd = { live_games: [feed.live_games[0]] };
    expect(p.parseFeed(pastEnd, feed.live_games[0].ended_ms + 1)).toEqual([]);
  });

  test('exposes the site channels as 24/7 networks, de-duplicating repeated links', () => {
    const channels = makeProvider().parseFeed(feed, PRE_GAME).filter(m => m.category === 'networks');
    expect(channels.map(c => c.id).sort()).toEqual(['nbamonster_ch_espn-plus', 'nbamonster_ch_nba-tv', 'nbamonster_ch_nhl-network']);
    const nhl = channels.find(c => c.id === 'nbamonster_ch_nhl-network');
    expect(nhl.sources).toHaveLength(2); // the feed lists ch02 twice
    expect(nhl.logo).toMatch(/^https:\/\/nbamonster\.com\/uploads\//);
  });

  test('tolerates malformed feeds', () => {
    const p = makeProvider();
    expect(p.parseFeed(null)).toEqual([]);
    expect(p.parseFeed({ live_games: [{}, { home: 'A', away: 'B', kickoff_ms: 'soon', links: [] }] })).toEqual([]);
  });
});

describe('NbaMonsterProvider.getMatches error handling', () => {
  test('returns [] on timeout / HTTP error / bad JSON', async () => {
    const p = makeProvider();
    p.fetchFeed = { fire: async () => { throw new Error('safeFetch timeout 10000ms'); } };
    await expect(p.getMatches()).resolves.toEqual([]);

    p.fetchFeed = null;
    p.proxyFetch = async () => ({ ok: false, status: 403 });
    await expect(p.getMatches()).resolves.toEqual([]);
    p.proxyFetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(p.getMatches()).resolves.toEqual([]);
  });
});

describe('NbaMonsterProvider.resolveStream', () => {
  const wrapperUrl = 'https://piratecat.store/smartplayer.php?hd=indiana-pacers=ch01';

  test('taifood embeds are delegated to the PPV.st extractor; its web fallback is dropped', async () => {
    const ppvResolve = jest.fn(async (id, cat, title, src) => [
      { name: 'PpvSt', title: 'PpvSt - Link 1 (x)', url: 'https://srv.local/api/manifest?url=abc', behaviorHints: { notWebReady: true } },
      { name: 'PpvSt', title: 'x (Web Player)', externalUrl: '/watch?url=y' }
    ]);
    const p = makeProvider({ ppvStProvider: { resolveStream: ppvResolve } });
    p.proxyFetch = jest.fn(async () => ({ ok: true, text: async () => SMARTPLAYER_TAIFOOD }));

    const streams = await p.resolveStream('id', 'basketball', 'Denver Nuggets @ Indiana Pacers', { url: wrapperUrl, channelName: 'Link 1' });

    expect(p.proxyFetch).toHaveBeenCalledTimes(1);
    // piratecat answers "Access Denied" to non-iframe navigations.
    expect(p.proxyFetch.mock.calls[0][1].headers).toMatchObject({ Referer: 'https://nbamonster.com/', 'Sec-Fetch-Dest': 'iframe' });
    expect(ppvResolve).toHaveBeenCalledWith(
      'https://taifood-blog.asia/embed/nba/2026-11-07/den-ind', 'basketball', 'Denver Nuggets @ Indiana Pacers',
      { embedUrl: 'https://taifood-blog.asia/embed/nba/2026-11-07/den-ind', channelName: 'Link 1' }
    );
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({ name: 'NBAMonster', title: 'NBAMonster (Link 1)', url: 'https://srv.local/api/manifest?url=abc' });
    expect(streams[1].externalUrl).toBe(`/watch?url=${encodeURIComponent(wrapperUrl)}&title=${encodeURIComponent('Denver Nuggets @ Indiana Pacers')}`);
  });

  test('other embeds go through EmbedExtractorChain with the wrapper as referer', async () => {
    const p = makeProvider({ ppvStProvider: { resolveStream: jest.fn() } });
    p.proxyFetch = jest.fn(async (url) => ({
      ok: true,
      text: async () => (url.startsWith('https://piratecat.store/relay/') ? EMBED_WITH_M3U8 : SMARTPLAYER_OTHER)
    }));
    const streams = await p.resolveStream('id', 'basketball', 'G', { url: wrapperUrl, channelName: 'Link 7' });
    expect(p.proxyFetch).toHaveBeenCalledTimes(2);
    expect(p.proxyFetch.mock.calls[1][1].headers.Referer).toBe(wrapperUrl);
    expect(streams[0]).toMatchObject({
      url: 'https://cdn.example.net/live/es105/index.m3u8?token=xyz',
      behaviorHints: { proxyHeaders: { request: expect.objectContaining({ Referer: 'https://piratecat.store/', Origin: 'https://piratecat.store' }) } }
    });
    expect(streams).toHaveLength(2);
  });

  test('access-denied wrapper or network errors still return the web fallback', async () => {
    const p = makeProvider({ ppvStProvider: { resolveStream: jest.fn() } });
    p.proxyFetch = async () => ({ ok: true, text: async () => '<title>Access Denied</title>' });
    let streams = await p.resolveStream('id', 'basketball', 'G', { url: wrapperUrl });
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toBeDefined();

    p.proxyFetch = async () => { throw new Error('safeFetch timeout 8000ms'); };
    streams = await p.resolveStream(Buffer.from(wrapperUrl).toString('base64url'), 'basketball', 'G', {});
    expect(streams).toHaveLength(1);
  });

  test('returns nothing without a usable URL', async () => {
    await expect(makeProvider().resolveStream('', 'basketball', 'G', {})).resolves.toEqual([]);
  });
});

describe('NBAMonster games merge with the same game from other providers', () => {
  test('"Away @ Home" matches "Away vs. Home" at the same tip-off', () => {
    const agg = new MatchAggregator({});
    const game = makeProvider().parseFeed(feed, PRE_GAME)[0];
    expect(agg.isSameEvent(game, { id: 'angulismo_691936890', title: 'Denver Nuggets vs. Indiana Pacers', category: 'basketball', date: game.date })).toBe(true);
  });
});
