'use strict';

process.env.NODE_ENV = 'test';

const AngulismoProvider = require('../src/providers/AngulismoProvider');
const { parseFecha, splitEventTitle } = AngulismoProvider;
const datos = require('./fixtures/providers/angulismo-datos.json');

const passthroughBreaker = {
  wrap: (name, fn) => ({ fire: fn }),
  wrapSync: (name, fn) => ({ fire: fn })
};

// 2026-11-07 20:30 UTC = 17:30 in Buenos Aires: Valencia-Real Madrid (17:00 ART)
// has kicked off, the morning FIP final (08:00 ART) is long over.
const NOW = Date.parse('2026-11-07T20:30:00Z');

// Real streamtp-family embed markup (trimmed), signed playlist in plain text.
const STREAMTP_HTML = `<!DOCTYPE html><html><head>
<script src="https://cdn.jsdelivr.net/npm/@clappr/player@0.8.0/dist/clappr.min.js"></script></head>
<body><div id="player"></div>
<script>var player = cdnpeer.clappr(Clappr, {"id":"ntyvybwc","src":"https://85.domhsd.com:443/global/espn4/mono.m3u8?token=abc-a5-1794103004-1794085004","canal":"espn4","parentId":"#player"});</script>
</body></html>`;

function makeProvider() {
  return new AngulismoProvider({ circuitBreaker: passthroughBreaker });
}

describe('AngulismoProvider helpers', () => {
  test('reads agenda times as Argentina local time (UTC-3)', () => {
    expect(parseFecha('2026-11-07 17:00:00')).toBe(Date.parse('2026-11-07T20:00:00Z'));
    expect(parseFecha('2026-11-08 00:10:00')).toBe(Date.parse('2026-11-08T03:10:00Z'));
    expect(parseFecha('')).toBeNull();
    expect(parseFecha('mañana')).toBeNull();
  });

  test('strips the competition prefix only from head-to-head titles', () => {
    expect(splitEventTitle('LaLiga: Valencia vs. Real Madrid')).toEqual({ title: 'Valencia vs. Real Madrid', prefix: 'LaLiga' });
    expect(splitEventTitle('Fórmula 1: GP Brasil - Clasificación')).toEqual({ title: 'Fórmula 1: GP Brasil - Clasificación', prefix: '' });
  });
});

describe('AngulismoProvider.parseData', () => {
  let nowSpy;
  beforeEach(() => { nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => nowSpy.mockRestore());

  test('maps agenda events: title, league, category, kickoff, live status, team logos', () => {
    const matches = makeProvider().parseData(datos);
    const events = matches.filter(m => m.category !== 'networks');

    // The 08:00 ART FIP final is more than 4h old and is dropped.
    expect(events.find(m => /FIP/.test(m.title))).toBeUndefined();

    const rm = events.find(m => m.id === 'angulismo_182005141');
    expect(rm).toMatchObject({
      title: 'Valencia vs. Real Madrid',
      league: 'LaLiga',
      category: 'football',
      status: 'live',
      date: String(Date.parse('2026-11-07T20:00:00Z'))
    });
    expect(rm.team1.name).toBe('Valencia');
    expect(rm.team2.name).toBe('Real Madrid');

    // Competitions normalizeCategory does not know are still football / motorsport / basketball.
    expect(events.find(m => /Boca Juniors/.test(m.title)).category).toBe('football');
    expect(events.find(m => /Clasificación/.test(m.title)).category).toBe('motorsport');
    const nba = events.find(m => /Nuggets/.test(m.title));
    expect(nba.category).toBe('basketball');
    expect(nba.status).toBe('upcoming');
  });

  test('every channel option becomes a Spanish-tagged angulismo source', () => {
    const rm = makeProvider().parseData(datos).find(m => m.id === 'angulismo_182005141');
    expect(rm.sources.length).toBe(8); // DSports x7 + ESPN+ x1
    for (const s of rm.sources) {
      expect(s.source).toBe('angulismo');
      expect(Buffer.from(s.id, 'base64url').toString()).toBe(s.url);
      expect(s.language).toBe('Spanish');
    }
  });

  test('exposes visible sports channels and drops hidden / non-TV grid entries', () => {
    const channels = makeProvider().parseData(datos).filter(m => m.category === 'networks');
    expect(channels.map(c => c.id).sort()).toEqual(['angulismo_ch_espn', 'angulismo_ch_lpf-play']);
    const lpf = channels.find(c => c.id === 'angulismo_ch_lpf-play');
    expect(lpf.sources.map(s => s.url)).toEqual([
      'https://emitiendoenvivo.com/lpf/1.m3u8',
      'https://emitiendoenvivo.com/lpf/2.m3u8',
      'https://emitiendoenvivo.com/lpf/3.m3u8'
    ]);
    expect(lpf.logo).toMatch(/^https:\/\//);
  });

  test('tags English-labelled options as English', () => {
    const data = { events: [], channels: [{ name: 'FOX', show: true, options: [{ name: 'Opción 12 (Ingles)', iframe: 'https://x.test/fox4k' }] }] };
    expect(makeProvider().parseData(data)[0].sources[0].language).toBe('English');
  });

  test('ignores non-http options and survives malformed input', () => {
    const p = makeProvider();
    expect(p.parseData(null)).toEqual([]);
    expect(p.parseData({ events: 'x', channels: 3 })).toEqual([]);
    expect(p.parseData({ events: [{ id: 1, evento: 'A vs. B', fecha: '2026-11-07 18:00:00', canales: [{ name: 'X', options: [{ iframe: 'javascript:alert(1)' }] }] }] })).toEqual([]);
  });
});

describe('AngulismoProvider.getMatches error handling', () => {
  test('returns [] on network failure', async () => {
    const p = makeProvider();
    p.fetchData = { fire: async () => { throw new Error('safeFetch timeout 10000ms'); } };
    await expect(p.getMatches()).resolves.toEqual([]);
  });

  test('returns [] on HTTP error and on bad JSON', async () => {
    const p = makeProvider();
    p.fetchData = null;
    p.proxyFetch = async () => ({ ok: false, status: 503 });
    await expect(p.getMatches()).resolves.toEqual([]);
    p.proxyFetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
    await expect(p.getMatches()).resolves.toEqual([]);
  });
});

describe('AngulismoProvider.resolveStream', () => {
  test('direct .m3u8 options play straight from the CDN with the site as referer', async () => {
    const p = makeProvider();
    p.proxyFetch = jest.fn();
    const url = 'https://emitiendoenvivo.com/lpf/1.m3u8';
    const streams = await p.resolveStream(Buffer.from(url).toString('base64url'), 'networks', 'LPF Play', { url, channelName: 'LPF Play', optionName: 'Opción 1', language: 'Spanish' });
    expect(p.proxyFetch).not.toHaveBeenCalled();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      url,
      language: 'Spanish',
      title: 'Angulismo (LPF Play · Opción 1)',
      behaviorHints: { proxyHeaders: { request: expect.objectContaining({ Referer: 'https://angulismotv.pages.dev/', Origin: 'https://angulismotv.pages.dev' }) } }
    });
  });

  test('embeds are fetched once and the plain signed playlist is extracted', async () => {
    const p = makeProvider();
    p.proxyFetch = jest.fn(async () => ({ ok: true, text: async () => STREAMTP_HTML }));
    const url = 'https://streamtp99a.sbs/global1.php?stream=espn4';
    const streams = await p.resolveStream('ignored', 'football', 'Valencia vs. Real Madrid', { url, channelName: 'ESPN 4', optionName: 'Opción 2 (FL)', language: 'Spanish' });

    expect(p.proxyFetch).toHaveBeenCalledTimes(1);
    expect(p.proxyFetch.mock.calls[0][1].headers.Referer).toBe('https://angulismotv.pages.dev/');
    expect(streams).toHaveLength(2);
    expect(streams[0].url).toBe('https://85.domhsd.com:443/global/espn4/mono.m3u8?token=abc-a5-1794103004-1794085004');
    expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://streamtp99a.sbs/');
    // No nested parentheses in the label.
    expect(streams[0].title).toBe('Angulismo (ESPN 4 · Opción 2 FL)');
    expect(streams[1].externalUrl).toContain(encodeURIComponent(url));
  });

  test('a dead embed still yields the web-player fallback', async () => {
    const p = makeProvider();
    p.proxyFetch = async () => { throw new Error('safeFetch timeout 8000ms'); };
    const url = 'https://tvlibre.st/html/fl/?get=RVNQTkhE';
    const streams = await p.resolveStream(Buffer.from(url).toString('base64url'), 'football', 'X', {});
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain(encodeURIComponent(url));
    expect(streams[0].language).toBe('Spanish');
  });

  test('returns nothing without a usable URL', async () => {
    await expect(makeProvider().resolveStream('', 'x', 'y', {})).resolves.toEqual([]);
  });
});
