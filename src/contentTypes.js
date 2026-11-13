'use strict';

/**
 * Content types the add-on serves.
 *
 * Matches live under a custom "Sports" type, so clients (Stremio, Nuvio) list
 * them as their own section next to Movies / Series instead of mixing them into
 * "TV channels". 24/7 networks keep the standard "tv" type. "series" carries the
 * replay hubs (seasons/episodes) and "channel" is accepted for older installs.
 */
const SPORTS_TYPE = 'Sports';

const SUPPORTED_TYPES = new Set([SPORTS_TYPE, 'tv', 'series', 'channel']);

function isSupportedType(type) {
  return SUPPORTED_TYPES.has(type);
}

module.exports = { SPORTS_TYPE, SUPPORTED_TYPES, isSupportedType };
