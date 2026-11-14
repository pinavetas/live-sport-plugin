'use strict';

/**
 * PlooplayerService — serves a user's Plooplayer list as Stremio catalogs.
 *
 * Config keys (from /configure, carried in the install URL):
 *   plooplayerList       URL of the root W3U list
 *   plooplayerDecryptor  base URL of the local decryptor (e.g. http://127.0.0.1:8090)
 *
 * Bandwidth (I1/I8): this service only ever emits URLs. ClearKey DASH channels
 * point at the viewer's *local* decryptor, which fetches and decrypts the media
 * on the viewer's own device; nothing media-sized transits this add-on. Without
 * a decryptor those channels are listed with an explanatory entry instead.
 *
 * Caching: one parsed model per list URL, fresh for PLOOPLAYER_LIST_TTL_MS
 * (10 min), served stale for up to 6 h if the list host is down.
 */

const {
  PLOO_TYPE,
  ID_PREFIX,
  buildChannelModel,
  channelsForGenre,
  cleanLabel
} = require('./plooplayer/PlooChannels');
const { KIND } = require('./plooplayer/PlooListParser');
const { encodeDecryptorToken } = require('./plooplayer/PlooDecryptorToken');

const FRESH_MS = Number(process.env.PLOOPLAYER_LIST_TTL_MS) || 10 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const MAX_LISTS = 16;
const PAGE_SIZE = 100;
const DECRYPTOR_MASTER_PATH = '/ploo/index.m3u8';

function httpUrl(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  try {
    const url = new URL(v);
    return url.protocol === 'http:' || url.protocol === 'https:' ? v : '';
  } catch (_) {
    return '';
  }
}

function listUrlFrom(config) {
  return httpUrl(config && config.plooplayerList);
}

function decryptorFrom(config) {
  return httpUrl(config && config.plooplayerDecryptor).replace(/\/+$/, '');
}

function isPlooplayerRequest(type, id) {
  return type === PLOO_TYPE || (typeof id === 'string' && id.startsWith(ID_PREFIX));
}

const KIND_LABEL = {
  [KIND.DASH]: 'ClearKey',
  [KIND.HLS]: 'HLS',
  [KIND.DIRECT]: 'Directo',
  [KIND.ACESTREAM]: 'AceStream'
};

class PlooplayerService {
  constructor({ plooplayerProvider } = {}) {
    this.provider = plooplayerProvider;
    this._models = new Map();   // listUrl -> { ts, model }
    this._inflight = new Map(); // listUrl -> Promise<model>
    this.now = () => Date.now();
  }

  /* ───────────────────────────── list model ───────────────────────────── */

  async _load(listUrl) {
    const tree = await this.provider.loadList(listUrl);
    const model = buildChannelModel(tree);
    model.stats = tree.stats;
    return model;
  }

  /**
   * @param {string} listUrl
   * @returns {Promise<object>} channel model (see PlooChannels.buildChannelModel)
   */
  async getModel(listUrl) {
    const cached = this._models.get(listUrl);
    if (cached && this.now() - cached.ts < FRESH_MS) return cached.model;

    let pending = this._inflight.get(listUrl);
    if (!pending) {
      pending = this._load(listUrl).finally(() => this._inflight.delete(listUrl));
      this._inflight.set(listUrl, pending);
    }
    try {
      const model = await pending;
      this._models.delete(listUrl);
      this._models.set(listUrl, { ts: this.now(), model });
      while (this._models.size > MAX_LISTS) this._models.delete(this._models.keys().next().value);
      return model;
    } catch (err) {
      if (cached && this.now() - cached.ts < STALE_MS) {
        console.warn(`[Plooplayer] list refresh failed, serving stale copy: ${err && err.message}`);
        return cached.model;
      }
      throw err;
    }
  }

  /* ───────────────────────────── manifest ─────────────────────────────── */

  /** One catalog per top-level group; deeper groups become its genre filter. */
  async manifestCatalogs(config) {
    const listUrl = listUrlFrom(config);
    if (!listUrl) return [];
    const model = await this.getModel(listUrl);
    return model.rows.map((row) => {
      const extra = [];
      if (row.genres.length > 0) {
        extra.push({ name: 'genre', options: row.genres.map((g) => g.label), isRequired: false });
      }
      extra.push({ name: 'skip', isRequired: false });
      return { type: PLOO_TYPE, id: row.id, name: row.name, extra };
    });
  }

  /* ─────────────────────────── catalog / meta ─────────────────────────── */

  _genreLabels(channel, row) {
    return row.genres.filter((g) => channel.genreKeys.has(g.key)).map((g) => g.label);
  }

  _description(channel) {
    const counts = new Map();
    for (const v of channel.variants) {
      const label = KIND_LABEL[v.station.kind] || v.station.kind;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const kinds = [...counts].map(([label, n]) => `${n} ${label}`).join(' · ');
    const paths = [...new Set(channel.variants.map((v) => v.path).filter(Boolean))];
    const info = [...new Set(channel.variants.map((v) => v.station.info).filter(Boolean))];
    return [kinds, ...paths.map((p) => `📂 ${p}`), ...info].filter(Boolean).join('\n');
  }

  _metaPreview(channel, row) {
    return {
      id: channel.id,
      type: PLOO_TYPE,
      name: channel.name,
      poster: channel.image || channel.fallbackImage || undefined,
      posterShape: 'landscape',
      genres: this._genreLabels(channel, row),
      description: this._description(channel),
      behaviorHints: { defaultVideoId: channel.id }
    };
  }

  async catalog({ id, extra, config }) {
    const listUrl = listUrlFrom(config);
    if (!listUrl) return { metas: [] };
    let model;
    try {
      model = await this.getModel(listUrl);
    } catch (err) {
      console.warn(`[Plooplayer] catalog ${id}: ${err && err.message}`);
      return { metas: [], cacheMaxAge: 30 };
    }
    const row = model.rowsById.get(id);
    if (!row) return { metas: [], cacheMaxAge: 60 };
    const skip = Math.max(0, parseInt(extra && extra.skip, 10) || 0);
    const channels = channelsForGenre(row, extra && extra.genre).slice(skip, skip + PAGE_SIZE);
    return {
      metas: channels.map((channel) => this._metaPreview(channel, row)),
      cacheMaxAge: Math.round(FRESH_MS / 1000),
      staleRevalidate: 3600
    };
  }

  async meta({ id, config }) {
    const listUrl = listUrlFrom(config);
    if (!listUrl) return { meta: null };
    let model;
    try {
      model = await this.getModel(listUrl);
    } catch (err) {
      console.warn(`[Plooplayer] meta ${id}: ${err && err.message}`);
      return { meta: null, cacheMaxAge: 30 };
    }
    const channel = model.channelsById.get(id);
    const row = channel && model.rowsById.get(channel.rowId);
    if (!channel || !row) return { meta: null, cacheMaxAge: 60 };
    return {
      meta: {
        ...this._metaPreview(channel, row),
        background: row.image || channel.fallbackImage || undefined,
        logo: channel.image || undefined
      },
      cacheMaxAge: Math.round(FRESH_MS / 1000)
    };
  }

  /* ────────────────────────────── streams ─────────────────────────────── */

  _stream(variant, channel, decryptor) {
    const s = variant.station;
    const lines = [cleanLabel(s.name), variant.path ? `📂 ${variant.path}` : '', s.info].filter(Boolean);
    const bingeGroup = `plooplayer-${channel.rowId}`;
    const describe = (extraLine) => {
      const text = lines.concat(extraLine || []).join('\n');
      return { title: text, description: text };
    };

    if (s.kind === KIND.DASH) {
      if (!decryptor) return null;
      const d = encodeDecryptorToken({ mpdUrl: s.url, keys: s.keys, headers: s.headers });
      const encrypted = Object.keys(s.keys).length > 0;
      return {
        name: `Plooplayer\n${encrypted ? 'ClearKey' : 'DASH'}`,
        ...describe('🔓 Descifrador local'),
        url: `${decryptor}${DECRYPTOR_MASTER_PATH}?d=${d}`,
        behaviorHints: { notWebReady: false, bingeGroup }
      };
    }
    if (s.kind === KIND.HLS || s.kind === KIND.DIRECT) {
      const behaviorHints = { bingeGroup };
      if (Object.keys(s.headers).length > 0) {
        behaviorHints.notWebReady = true;
        behaviorHints.proxyHeaders = { request: { ...s.headers } };
      }
      return { name: `Plooplayer\n${KIND_LABEL[s.kind]}`, ...describe(), url: s.url, behaviorHints };
    }
    if (s.kind === KIND.ACESTREAM) {
      return {
        name: 'Plooplayer\nAceStream',
        ...describe('📡 Se abre en la app Ace Stream'),
        externalUrl: s.url
      };
    }
    return null;
  }

  /**
   * @param {{id: string, config: object, baseUrl?: string}} args  baseUrl is the
   *        public origin of this request, used for the "configure" link.
   */
  async streams({ id, config, baseUrl }) {
    const listUrl = listUrlFrom(config);
    if (!listUrl) return { streams: [] };
    let model;
    try {
      model = await this.getModel(listUrl);
    } catch (err) {
      console.warn(`[Plooplayer] streams ${id}: ${err && err.message}`);
      return { streams: [], cacheMaxAge: 10 };
    }
    const channel = model.channelsById.get(id);
    if (!channel) return { streams: [], cacheMaxAge: 30 };

    const decryptor = decryptorFrom(config);
    const inApp = [];
    const external = [];
    let needsDecryptor = 0;
    for (const variant of channel.variants) {
      const stream = this._stream(variant, channel, decryptor);
      if (stream) (stream.externalUrl ? external : inApp).push(stream);
      else if (variant.station.kind === KIND.DASH) needsDecryptor += 1;
    }

    const streams = inApp.concat(external);
    if (needsDecryptor > 0) {
      const text = `${needsDecryptor} opción(es) ClearKey necesitan el descifrador local.\n` +
        'Instálalo en la tele y añade su URL en /configure.';
      streams.push({
        name: 'Plooplayer\n⚠️ ClearKey',
        title: text,
        description: text,
        externalUrl: configureUrl(baseUrl, config)
      });
    }
    return { streams, cacheMaxAge: 60 };
  }
}

/** The configure page pre-filled with this install's config. */
function configureUrl(baseUrl, config) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const encoded = Buffer.from(JSON.stringify(config || {}), 'utf8').toString('base64url');
  return `${base}/${encoded}/configure`;
}

module.exports = PlooplayerService;
module.exports.isPlooplayerRequest = isPlooplayerRequest;
module.exports.listUrlFrom = listUrlFrom;
module.exports.decryptorFrom = decryptorFrom;
module.exports.PLOO_TYPE = PLOO_TYPE;
module.exports.ID_PREFIX = ID_PREFIX;
module.exports.DECRYPTOR_MASTER_PATH = DECRYPTOR_MASTER_PATH;
