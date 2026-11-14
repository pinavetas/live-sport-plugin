'use strict';

const { encryptPloo } = require('../src/services/plooplayer/PlooCrypto');
const { parsePlooList, normalizeStation, parseKeys, KIND } = require('../src/services/plooplayer/PlooListParser');

const KID1 = '573117b598d24b76b25e348ecb1c7ebe';
const KEY1 = 'b1acb08c7b775d25a5d73bd41e31dcd5';
const KID2 = 'cb80e1e7d7598eaf98b1dbbe6dc14ee9';
const KEY2 = '103ae55c7948ca1d159d6743619d26c4';

describe('normalizeStation', () => {
  test('ClearKey DASH: encrypted URL, several kid:key pairs and encrypted headers', () => {
    const station = normalizeStation({
      name: 'DAZN 1',
      image: 'https://img.example/dazn.png',
      info: '🔒 Contenido Premium (Mira 2 anuncios)',
      p: '',
      ploorl: encryptPloo('https://cdn.example.com/live/dazn1/manifest.mpd'),
      qqs: { qs: [encryptPloo(`${KID1}:${KEY1}`), encryptPloo(`${KID2.toUpperCase()}:${KEY2}`)], isbase64: false },
      ploore: encryptPloo('https://www.izzigo.tv'),
      ploori: encryptPloo('https://www.izzigo.tv'),
      ploousag: encryptPloo('Mozilla/5.0 Test')
    });
    expect(station).toEqual({
      name: 'DAZN 1',
      image: 'https://img.example/dazn.png',
      info: '', // the app's ad wall is not information
      kind: KIND.DASH,
      url: 'https://cdn.example.com/live/dazn1/manifest.mpd',
      keys: { [KID1]: KEY1, [KID2]: KEY2 },
      headers: { Referer: 'https://www.izzigo.tv', Origin: 'https://www.izzigo.tv', 'User-Agent': 'Mozilla/5.0 Test' }
    });
  });

  test('plain-text headers are used when the encrypted ones are absent', () => {
    const station = normalizeStation({
      name: 'SKY sports 21',
      ploorl: encryptPloo('https://live1-ott.example.tv/13/out/u/dash/SKY/default.mpd'),
      qqs: { qs: [encryptPloo(`${KID1}:${KEY1}`)] },
      referer: 'https://www.izzigo.tv',
      origin: 'https://www.izzigo.tv',
      userAgent: 'UA plain'
    });
    expect(station.headers).toEqual({ Referer: 'https://www.izzigo.tv', Origin: 'https://www.izzigo.tv', 'User-Agent': 'UA plain' });
  });

  test('classifies HLS, AceStream, web pages and drops unusable entries', () => {
    expect(normalizeStation({ name: 'tvg2', url: 'https://crtvg.example/playlist.m3u8', isHost: 'true' }).kind).toBe(KIND.HLS);
    expect(normalizeStation({ name: 'ACB', url: 'acestream://fd2aea1aa8fcddebfda1644118c6806230a1d539', info: 'bdb2' }))
      .toMatchObject({ kind: KIND.ACESTREAM, url: 'acestream://fd2aea1aa8fcddebfda1644118c6806230a1d539', info: 'bdb2' });
    expect(normalizeStation({ name: 'TELEGRAM', url: 'https://t.me/x', embed: 'true' }).kind).toBe(KIND.WEB);
    expect(normalizeStation({ name: 'Direct', url: 'https://cdn.example/stream.ts' }).kind).toBe(KIND.DIRECT);
    expect(normalizeStation({ name: 'no url' })).toBeNull();
    expect(normalizeStation({ name: 'plugin', url: 'plugin://video/x' })).toBeNull();
    expect(normalizeStation({ name: 'bad cipher', ploorl: 'Zm9vYmFy' })).toBeNull();
  });

  test('parseKeys accepts base64 pairs and skips undecodable entries', () => {
    const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64url');
    expect(parseKeys({ qs: [encryptPloo(`${b64(KID1)}:${b64(KEY1)}`), 'garbage', encryptPloo('no-separator')] }))
      .toEqual({ [KID1]: KEY1 });
  });
});

describe('parsePlooList', () => {
  const hdList = {
    name: 'C4nales HD+',
    pl: encryptPloo('0.9.9'),
    stations: [
      { name: 'LaLiga TV Bar', ploorl: encryptPloo('https://bar.example/drm.mpd'), qqs: { qs: [encryptPloo(`${KID1}:${KEY1}`)] } },
      { name: 'tvg2', url: 'https://tvg2.example/playlist.m3u8' }
    ]
  };
  const aceList = {
    name: 'AceStream iDs',
    groups: [
      { name: 'BALONCESTO', stations: [{ name: 'ACB 720p *', url: 'acestream://1111111111111111111111111111111111111111' }] },
      { name: 'DAZN', stations: [{ name: 'DAZN 1 1080p **', url: 'acestream://2222222222222222222222222222222222222222' }] }
    ]
  };
  const root = {
    name: 'MEGA LISTA',
    author: 'Staff',
    pl: encryptPloo('0.9.9'),
    groups: [
      { name: '+ NOVEDADES', stations: [{ name: 'TELEGRAM', url: 'https://t.me/x', embed: 'true' }] },
      {
        name: 'Eventos Deportivos HD+',
        image: 'https://img.example/hd.png',
        groups: [
          { name: 'Opcion 1 ✅ (ON)', ploorl: encryptPloo('https://lists.example/hd/raw') },
          { name: 'Opcion 2', ploorl: encryptPloo('https://lists.example/dead/raw') }
        ]
      },
      {
        name: 'Eventos 4cestre4m',
        groups: [{ name: 'Opcion 1 ✅ (ON)', ploorl: encryptPloo('https://lists.example/ace/raw'), import: true }]
      },
      { name: 'Loop', groups: [{ name: 'back to root', url: 'https://lists.example/root/raw' }] }
    ]
  };

  const fetchJson = jest.fn(async (url) => {
    if (url === 'https://lists.example/hd/raw') return hdList;
    if (url === 'https://lists.example/ace/raw') return aceList;
    if (url === 'https://lists.example/root/raw') return root;
    throw new Error('HTTP 404');
  });

  test('follows sub-lists (plain and import) and keeps the app hierarchy', async () => {
    const tree = await parsePlooList(root, { fetchJson, rootUrl: 'https://lists.example/root/raw' });
    expect(tree.name).toBe('MEGA LISTA');
    expect(tree.groups.map((g) => g.name)).toEqual(['+ NOVEDADES', 'Eventos Deportivos HD+', 'Eventos 4cestre4m', 'Loop']);

    const [opt1, opt2] = tree.groups[1].groups;
    expect(opt1.stations.map((s) => [s.name, s.kind])).toEqual([['LaLiga TV Bar', KIND.DASH], ['tvg2', KIND.HLS]]);
    expect(opt1.stations[0].keys).toEqual({ [KID1]: KEY1 });
    expect(opt2.failed).toBe(true);
    expect(opt2.stations).toEqual([]);

    const imported = tree.groups[2].groups[0];
    expect(imported.groups.map((g) => g.name)).toEqual(['BALONCESTO', 'DAZN']);
    expect(imported.groups[1].stations[0]).toMatchObject({ name: 'DAZN 1 1080p **', kind: KIND.ACESTREAM });

    // web stations are kept by the parser (the channel model drops them)
    expect(tree.groups[0].stations[0].kind).toBe(KIND.WEB);
    // the root list is never fetched again through a cycle
    expect(fetchJson).not.toHaveBeenCalledWith('https://lists.example/root/raw');
    expect(tree.stats).toEqual({ sublists: 3, failedSublists: 1, skippedSublists: 1 });
  });

  test('a sub-list budget stops runaway lists', async () => {
    const tree = await parsePlooList(root, { fetchJson, maxSublists: 1 });
    expect(tree.stats.sublists).toBe(1);
    expect(tree.stats.skippedSublists).toBeGreaterThan(0);
  });

  test('rejects a root that is not a JSON object', async () => {
    await expect(parsePlooList(null, { fetchJson })).rejects.toThrow();
    await expect(parsePlooList([], { fetchJson })).rejects.toThrow();
  });
});
