'use strict';

const { KIND } = require('../src/services/plooplayer/PlooListParser');
const {
  buildChannelModel,
  channelsForGenre,
  channelKey,
  channelDisplayName,
  normalizedPathKey
} = require('../src/services/plooplayer/PlooChannels');

const st = (name, kind = KIND.ACESTREAM, extra = {}) => ({
  name, kind, url: kind === KIND.ACESTREAM ? `acestream://${name}` : `https://cdn.example/${encodeURIComponent(name)}.mpd`,
  image: '', info: '', keys: {}, headers: {}, ...extra
});

function tree(optionLabel = 'Opcion 1 ✅ (ON)') {
  return {
    name: 'MEGA LISTA',
    stations: [],
    groups: [
      { name: '+ NOVEDADES EN TELEGRAM', image: 'https://img/tg.png', groups: [], stations: [st('TELEGRAM', KIND.WEB)] },
      {
        name: 'Eventos Deportivos HD+',
        image: 'https://img/hd.png',
        stations: [],
        groups: [{
          name: optionLabel,
          groups: [],
          stations: [
            st('SKY sports 16', KIND.DASH, { image: 'https://img/sky16.png' }),
            st('Sky Sports 16 HD (servidor paz)', KIND.DASH),
            st('L4 Lig4 TV', KIND.DASH),
            st('L4 Lig4 TV', KIND.DASH),
            st('tvg2', KIND.HLS)
          ]
        }]
      },
      {
        name: 'Eventos Deportivos 4cestre4m',
        image: 'https://img/ace.png',
        stations: [],
        groups: [{
          name: optionLabel,
          stations: [],
          groups: [
            { name: 'DAZN', image: '', groups: [], stations: [st('DAZN 1 720p *'), st('DAZN 1 1080p *'), st('DAZN 1 1080p **'), st('DAZN 2 1080p **')] },
            { name: 'LA LIGA', image: '', groups: [], stations: [st('DAZN 1 1080p ***'), st('M+ LaLiga 720p *')] }
          ]
        }]
      },
      { name: '🔒 ZONAPLOOP 📡', image: '', groups: [], stations: [st('EVENTOS', KIND.WEB)] }
    ]
  };
}

describe('channel naming', () => {
  test('variants collapse to the same key; distinct channels do not', () => {
    expect(channelKey('DAZN 1 720p *')).toBe('dazn 1');
    expect(channelKey('DAZN 1 1080p **')).toBe('dazn 1');
    expect(channelKey('Sky Sports 16 HD (servidor paz)')).toBe(channelKey('SKY sports 16'));
    expect(channelKey('L4 Lig4 Hypermot10n 1 (ON)')).toBe('l4 lig4 hypermot10n 1');
    expect(channelKey('24H TV 720p **')).toBe('24h tv');
    expect(channelKey('M LALIGA')).not.toBe(channelKey('M LALIGA 2'));
    expect(channelDisplayName('DAZN 1 1080p **')).toBe('DAZN 1');
    expect(channelDisplayName('Sky Sports 16 HD (servidor paz)')).toBe('Sky Sports 16 (servidor paz)');
  });

  test('genre paths compare without emojis or ON/OFF markers', () => {
    expect(normalizedPathKey('Opcion 1 ✅ (ON) › BALONCESTO')).toBe(normalizedPathKey('Opcion 1 ❌ (OFF) › baloncesto'));
  });
});

describe('buildChannelModel', () => {
  test('one row per top-level group with playable channels, in app order', () => {
    const model = buildChannelModel(tree());
    expect(model.rows.map((r) => [r.id, r.name])).toEqual([
      ['ploo_eventos_deportivos_hd', 'Eventos Deportivos HD+'],
      ['ploo_eventos_deportivos_4cestre4m', 'Eventos Deportivos 4cestre4m']
    ]);
  });

  test('quality/server variants are merged into one channel per row', () => {
    const model = buildChannelModel(tree());
    const hd = model.rowsById.get('ploo_eventos_deportivos_hd');
    expect(hd.channels.map((c) => [c.name, c.variants.length])).toEqual([
      ['SKY sports 16', 2], ['L4 Lig4 TV', 2], ['tvg2', 1]
    ]);
    const sky = hd.channels[0];
    expect(sky.image).toBe('https://img/sky16.png');
    expect(sky.fallbackImage).toBe('https://img/hd.png');

    const ace = model.rowsById.get('ploo_eventos_deportivos_4cestre4m');
    const dazn1 = ace.channels.find((c) => c.name === 'DAZN 1');
    // the same channel listed in two sub-groups is one channel with both paths
    expect(dazn1.variants.map((v) => v.path)).toEqual([
      'Opcion 1 ✅ (ON) › DAZN', 'Opcion 1 ✅ (ON) › DAZN', 'Opcion 1 ✅ (ON) › DAZN', 'Opcion 1 ✅ (ON) › LA LIGA'
    ]);
    expect(model.channelsById.get(dazn1.id)).toBe(dazn1);
  });

  test('deeper groups become genre filters, ancestors included', () => {
    const model = buildChannelModel(tree());
    const ace = model.rowsById.get('ploo_eventos_deportivos_4cestre4m');
    expect(ace.genres.map((g) => g.label)).toEqual([
      'Opcion 1 ✅ (ON)', 'Opcion 1 ✅ (ON) › DAZN', 'Opcion 1 ✅ (ON) › LA LIGA'
    ]);
    expect(channelsForGenre(ace, 'Opcion 1 ✅ (ON) › LA LIGA').map((c) => c.name)).toEqual(['DAZN 1', 'M+ LaLiga']);
    expect(channelsForGenre(ace, 'Opcion 1 ✅ (ON)')).toHaveLength(ace.channels.length);
    expect(channelsForGenre(ace, undefined)).toHaveLength(ace.channels.length);
    expect(channelsForGenre(ace, 'Nope')).toEqual([]);
  });

  test('ids and filters survive a status flip ("✅ (ON)" -> "❌ (OFF)")', () => {
    const before = buildChannelModel(tree('Opcion 1 ✅ (ON)'));
    const after = buildChannelModel(tree('Opcion 1 ❌ (OFF)'));
    expect([...after.channelsById.keys()]).toEqual([...before.channelsById.keys()]);
    const row = after.rowsById.get('ploo_eventos_deportivos_4cestre4m');
    // a client still holding the old manifest filter keeps getting results
    expect(channelsForGenre(row, 'Opcion 1 ✅ (ON) › DAZN').map((c) => c.name)).toEqual(['DAZN 1', 'DAZN 2']);
  });

  test('root-level stations get a row named after the list', () => {
    const model = buildChannelModel({ name: 'Mi lista', stations: [st('Canal suelto', KIND.HLS)], groups: [] });
    expect(model.rows.map((r) => r.name)).toEqual(['Mi lista']);
  });
});
