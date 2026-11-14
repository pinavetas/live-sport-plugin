'use strict';

const PlooplayerService = require('../src/services/PlooplayerService');
const { KIND } = require('../src/services/plooplayer/PlooListParser');
const { decodeDecryptorToken } = require('../src/services/plooplayer/PlooDecryptorToken');

const LIST = 'https://lists.example/root/raw';
const KID = '573117b598d24b76b25e348ecb1c7ebe';
const KEY = 'b1acb08c7b775d25a5d73bd41e31dcd5';

const station = (name, kind, extra = {}) => ({ name, kind, image: '', info: '', keys: {}, headers: {}, url: '', ...extra });

function sampleTree() {
  return {
    name: 'MEGA LISTA',
    stations: [],
    stats: { sublists: 2, failedSublists: 0, skippedSublists: 0 },
    groups: [
      {
        name: 'Eventos Deportivos HD+',
        image: 'https://img/hd.png',
        stations: [],
        groups: [{
          name: 'Opcion 1 ✅ (ON)',
          image: '',
          groups: [],
          stations: [
            station('SKY sports 16', KIND.DASH, {
              url: 'https://cdn.example/sky16/default.mpd',
              keys: { [KID]: KEY },
              headers: { Referer: 'https://www.izzigo.tv', Origin: 'https://www.izzigo.tv' }
            }),
            station('Sky Sports 16 HD (servidor paz)', KIND.DASH, { url: 'https://cdn2.example/sky16.mpd', keys: { [KID]: KEY } }),
            station('tvg2', KIND.HLS, { url: 'https://tvg2.example/playlist.m3u8', headers: { Referer: 'https://tvg.example/' } }),
            station('Canal ACE', KIND.ACESTREAM, { url: 'acestream://abc' })
          ]
        }]
      },
      {
        name: 'Eventos 4cestre4m',
        image: '',
        stations: [],
        groups: [{
          name: 'Opcion 1',
          image: '',
          stations: [],
          groups: [{
            name: 'DAZN',
            image: '',
            groups: [],
            stations: [
              station('DAZN 1 720p *', KIND.ACESTREAM, { url: 'acestream://1' }),
              station('DAZN 1 1080p **', KIND.ACESTREAM, { url: 'acestream://2' })
            ]
          }]
        }]
      }
    ]
  };
}

function makeService(loadList = jest.fn(async () => sampleTree())) {
  const service = new PlooplayerService({ plooplayerProvider: { loadList } });
  let clock = 1_000_000;
  service.now = () => clock;
  return { service, loadList, advance: (ms) => { clock += ms; } };
}

const config = { plooplayerList: LIST, plooplayerDecryptor: 'http://127.0.0.1:8090/' };

describe('PlooplayerService', () => {
  test('manifest catalogs: one row per top-level group with its genre paths', async () => {
    const { service } = makeService();
    expect(await service.manifestCatalogs({})).toEqual([]);
    const catalogs = await service.manifestCatalogs(config);
    expect(catalogs).toEqual([
      {
        type: 'Plooplayer',
        id: 'ploo_eventos_deportivos_hd',
        name: 'Eventos Deportivos HD+',
        extra: [{ name: 'genre', options: ['Opcion 1 ✅ (ON)'], isRequired: false }, { name: 'skip', isRequired: false }]
      },
      {
        type: 'Plooplayer',
        id: 'ploo_eventos_4cestre4m',
        name: 'Eventos 4cestre4m',
        extra: [{ name: 'genre', options: ['Opcion 1', 'Opcion 1 › DAZN'], isRequired: false }, { name: 'skip', isRequired: false }]
      }
    ]);
  });

  test('catalog lists merged channels, honours genre and skip', async () => {
    const { service } = makeService();
    const res = await service.catalog({ id: 'ploo_eventos_deportivos_hd', extra: {}, config });
    expect(res.metas.map((m) => m.name)).toEqual(['SKY sports 16', 'tvg2', 'Canal ACE']);
    expect(res.metas[0]).toMatchObject({
      type: 'Plooplayer',
      poster: 'https://img/hd.png', // group image when the station has none
      genres: ['Opcion 1 ✅ (ON)'],
      behaviorHints: { defaultVideoId: res.metas[0].id }
    });
    expect(res.metas[0].description).toContain('2 ClearKey');
    expect(res.cacheMaxAge).toBeGreaterThan(0);

    const filtered = await service.catalog({ id: 'ploo_eventos_4cestre4m', extra: { genre: 'Opcion 1 › DAZN' }, config });
    expect(filtered.metas.map((m) => m.name)).toEqual(['DAZN 1']);
    const skipped = await service.catalog({ id: 'ploo_eventos_deportivos_hd', extra: { skip: '100' }, config });
    expect(skipped.metas).toEqual([]);
    expect((await service.catalog({ id: 'ploo_unknown', extra: {}, config })).metas).toEqual([]);
  });

  test('meta returns the channel with the group art as background', async () => {
    const { service } = makeService();
    const { metas } = await service.catalog({ id: 'ploo_eventos_deportivos_hd', extra: {}, config });
    const { meta } = await service.meta({ id: metas[0].id, config });
    expect(meta).toMatchObject({ id: metas[0].id, name: 'SKY sports 16', background: 'https://img/hd.png' });
    expect((await service.meta({ id: 'ploo_missing', config })).meta).toBeNull();
  });

  test('ClearKey variants point at the local decryptor with keys and headers in the token', async () => {
    const { service } = makeService();
    const id = (await service.catalog({ id: 'ploo_eventos_deportivos_hd', extra: {}, config })).metas[0].id;
    const { streams } = await service.streams({ id, config, baseUrl: 'https://addon.example' });
    expect(streams).toHaveLength(2);
    for (const s of streams) {
      expect(s.url.startsWith('http://127.0.0.1:8090/ploo/index.m3u8?d=')).toBe(true);
      expect(s.name).toBe('Plooplayer\nClearKey');
      expect(s.description).toBe(s.title);
    }
    const token = decodeDecryptorToken(new URL(streams[0].url).searchParams.get('d'));
    expect(token).toEqual({
      mpdUrl: 'https://cdn.example/sky16/default.mpd',
      keys: { [KID]: KEY },
      headers: { Referer: 'https://www.izzigo.tv', Origin: 'https://www.izzigo.tv' }
    });
    expect(streams[1].title).toContain('Sky Sports 16 HD (servidor paz)');
  });

  test('without a decryptor, ClearKey channels get one explanatory entry linking to /configure', async () => {
    const { service } = makeService();
    const noDecryptor = { plooplayerList: LIST };
    const id = (await service.catalog({ id: 'ploo_eventos_deportivos_hd', extra: {}, config: noDecryptor })).metas[0].id;
    const { streams } = await service.streams({ id, config: noDecryptor, baseUrl: 'https://addon.example/' });
    expect(streams).toHaveLength(1);
    expect(streams[0].title).toMatch(/^2 opción\(es\) ClearKey/);
    const link = new URL(streams[0].externalUrl);
    expect(link.origin).toBe('https://addon.example');
    const encoded = link.pathname.split('/')[1];
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual(noDecryptor);
  });

  test('HLS keeps its headers as proxyHeaders; AceStream opens externally, after in-app streams', async () => {
    const { service } = makeService();
    const metas = (await service.catalog({ id: 'ploo_eventos_deportivos_hd', extra: {}, config })).metas;
    const hls = (await service.streams({ id: metas[1].id, config })).streams;
    expect(hls).toEqual([expect.objectContaining({
      url: 'https://tvg2.example/playlist.m3u8',
      behaviorHints: { bingeGroup: 'plooplayer-ploo_eventos_deportivos_hd', notWebReady: true, proxyHeaders: { request: { Referer: 'https://tvg.example/' } } }
    })]);
    const aceRow = (await service.catalog({ id: 'ploo_eventos_4cestre4m', extra: {}, config })).metas;
    const ace = (await service.streams({ id: aceRow[0].id, config })).streams;
    expect(ace.map((s) => s.externalUrl)).toEqual(['acestream://1', 'acestream://2']);
    expect(ace[0].name).toBe('Plooplayer\nAceStream');
    expect(ace[0].title).toContain('📂 Opcion 1 › DAZN');
  });

  test('caches the list, shares one load between concurrent callers and serves stale on failure', async () => {
    const loadList = jest.fn(async () => sampleTree());
    const { service, advance } = makeService(loadList);
    await Promise.all([service.getModel(LIST), service.getModel(LIST), service.getModel(LIST)]);
    expect(loadList).toHaveBeenCalledTimes(1);
    await service.getModel(LIST);
    expect(loadList).toHaveBeenCalledTimes(1);

    advance(11 * 60 * 1000); // past the 10 min freshness window
    loadList.mockRejectedValueOnce(new Error('list host down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = await service.getModel(LIST);
    expect(stale.rows).toHaveLength(2);
    expect(loadList).toHaveBeenCalledTimes(2);

    advance(7 * 60 * 60 * 1000); // past the stale window too
    loadList.mockRejectedValueOnce(new Error('still down'));
    await expect(service.getModel(LIST)).rejects.toThrow('still down');
    const empty = await service.catalog({ id: 'ploo_eventos_deportivos_hd', extra: {}, config: { plooplayerList: 'https://other.example/x' } });
    expect(empty.metas).toBeDefined();
    warn.mockRestore();
  });

  test('ignores configs without an http(s) list and recognises its own requests', async () => {
    const { service, loadList } = makeService();
    expect(await service.catalog({ id: 'ploo_x', extra: {}, config: { plooplayerList: 'javascript:alert(1)' } })).toEqual({ metas: [] });
    expect(loadList).not.toHaveBeenCalled();
    expect(PlooplayerService.isPlooplayerRequest('Plooplayer', 'anything')).toBe(true);
    expect(PlooplayerService.isPlooplayerRequest('tv', 'ploo_x')).toBe(true);
    expect(PlooplayerService.isPlooplayerRequest('Sports', 'nuvio_sport_x')).toBe(false);
  });
});
