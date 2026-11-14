'use strict';

/**
 * PlooChannels — maps a parsed Plooplayer tree onto Stremio concepts while
 * keeping the app's grouping:
 *
 *   top-level group   -> one catalog row (`ploo_<slug>`)
 *   deeper groups     -> the row's `genre` filter, as a path
 *                        ("Opcion 1 ✅ (ON) › BALONCESTO"); every ancestor path
 *                        is a filter too, so "Opcion 1" shows all of its children
 *   stations          -> channels; quality/server variants of the same channel
 *                        inside a row ("DAZN 1 720p *", "DAZN 1 1080p **") are
 *                        merged into one channel with one stream per variant
 *
 * Ids are derived from names with status decorations removed (emojis, "(ON)",
 * "(OFF)"), so a group flipping from "✅ (ON)" to "❌ (OFF)" keeps its row id,
 * its filter and its channel ids. Web pages (`embed`) are dropped.
 */

const { KIND } = require('./PlooListParser');

const PLOO_TYPE = 'Plooplayer';
const ID_PREFIX = 'ploo_';
const PATH_SEP = ' › ';

const EMOJI_RX = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
const STATUS_RX = /\(\s*(?:on|off)\s*\)/gi;
const QUALITY_RX = /\b(?:\d{3,4}p|4k|uhd|fhd|hd|sd)\b/gi;
const BRACKETS_RX = /\([^)]*\)|\[[^\]]*\]/g;

function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Removes emojis, keeps everything else. */
function cleanLabel(s) {
  return collapse(String(s || '').replace(EMOJI_RX, ' '));
}

/** cleanLabel() without "(ON)"/"(OFF)" markers: the stable part of a name. */
function statusFree(s) {
  return collapse(cleanLabel(s).replace(STATUS_RX, ' '));
}

function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function slug(s) {
  const out = fold(statusFree(s)).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return out || 'x';
}

/** Identity of a channel inside a row: no quality, server or status suffixes. */
function channelKey(name) {
  return collapse(
    fold(statusFree(name))
      .replace(BRACKETS_RX, ' ')
      .replace(QUALITY_RX, ' ')
      .replace(/\*/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
  );
}

/** What the channel is called once its variants are merged. */
function channelDisplayName(name) {
  const shown = collapse(statusFree(name).replace(QUALITY_RX, ' ').replace(/\*/g, ' '));
  return shown || cleanLabel(name) || 'Canal';
}

/** Comparable form of a genre path ("Opcion 1 ✅ (ON) › X" == "Opcion 1 › x"). */
function normalizedPathKey(path) {
  return String(path || '')
    .split(PATH_SEP.trim())
    .map((segment) => fold(statusFree(segment)))
    .filter(Boolean)
    .join('/');
}

function uniqueId(base, used) {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

/**
 * @param {{name: string, groups: object[], stations: object[]}} tree  PlooListParser output
 * @returns {{name: string, rows: object[], rowsById: Map, channelsById: Map}}
 */
function buildChannelModel(tree) {
  const rows = [];
  const rowsById = new Map();
  const channelsById = new Map();
  const usedRowIds = new Set();
  const usedChannelIds = new Set();

  function buildRow(name, image, rootNode) {
    const row = {
      id: uniqueId(`${ID_PREFIX}${slug(name)}`, usedRowIds),
      name: collapse(name) || 'Plooplayer',
      image: image || '',
      genres: [],      // [{ label, key }] in app order
      channels: []
    };
    const genreKeys = new Set();
    const byKey = new Map();

    const addGenrePaths = (segments, channel) => {
      for (let i = 1; i <= segments.length; i++) {
        const label = segments.slice(0, i).join(PATH_SEP);
        const key = normalizedPathKey(label);
        if (!key) continue;
        channel.genreKeys.add(key);
        if (!genreKeys.has(key)) {
          genreKeys.add(key);
          row.genres.push({ label, key });
        }
      }
    };

    const addStation = (station, segments, node) => {
      if (!station || station.kind === KIND.WEB) return;
      const key = channelKey(station.name) || fold(cleanLabel(station.name)) || 'canal';
      let channel = byKey.get(key);
      if (!channel) {
        channel = {
          id: uniqueId(`${row.id}__${slug(key)}`, usedChannelIds),
          rowId: row.id,
          name: channelDisplayName(station.name),
          image: station.image || '',
          fallbackImage: node.image || row.image || '',
          genreKeys: new Set(),
          variants: []
        };
        byKey.set(key, channel);
        row.channels.push(channel);
        channelsById.set(channel.id, channel);
      }
      if (!channel.image && station.image) channel.image = station.image;
      addGenrePaths(segments, channel);
      channel.variants.push({ station, path: segments.join(PATH_SEP) });
    };

    const visit = (node, segments) => {
      for (const station of node.stations || []) addStation(station, segments, node);
      for (const child of node.groups || []) visit(child, segments.concat(collapse(child.name)));
    };
    visit(rootNode, []);

    if (row.channels.length > 0) {
      rows.push(row);
      rowsById.set(row.id, row);
    }
  }

  const listName = collapse(tree && tree.name) || 'Plooplayer';
  if (tree && Array.isArray(tree.stations) && tree.stations.length > 0) {
    buildRow(listName, '', { stations: tree.stations, groups: [] });
  }
  for (const group of (tree && tree.groups) || []) {
    buildRow(group.name, group.image, group);
  }

  return { name: listName, rows, rowsById, channelsById };
}

/** Channels of a row, optionally narrowed to a genre path (any ancestor level). */
function channelsForGenre(row, genre) {
  if (!row) return [];
  const key = normalizedPathKey(genre);
  if (!key) return row.channels;
  return row.channels.filter((channel) => channel.genreKeys.has(key));
}

module.exports = {
  PLOO_TYPE,
  ID_PREFIX,
  PATH_SEP,
  buildChannelModel,
  channelsForGenre,
  channelKey,
  channelDisplayName,
  normalizedPathKey,
  cleanLabel,
  slug
};
