/**
 * manifest.js — Stremio / Nuvio Addon Manifest
 *
 * Live sports events and 24/7 sports networks aggregator.
 */

const { addonBuilder } = require('stremio-addon-sdk');
const { SPORTS_TYPE } = require('./contentTypes');

const manifest = {
  id: 'community.nuvio.live-sports',
  version: '3.2.0',
  name: '🏆 Live Sports',
  description:
    'The ultimate live sports aggregator. Stream live Football, NBA, NFL, NHL, F1, and more. ' +
    'Aggregates high-speed live streams and 24/7 sports TV networks with zero-lag playback.',
  logo: '/logo.png',

  types: [SPORTS_TYPE, 'tv', 'series', 'channel'],
  resources: ['catalog', 'meta', 'stream'],

  catalogs: [
    // ── Sports (custom type: its own section in the client) ──
    { type: SPORTS_TYPE, id: 'nuvio_sports_live', name: '🔴 Live Now', extra: [
      { name: 'genre', options: ['Football', 'Cricket', 'Basketball', 'Motorsport', 'Tennis', 'Baseball', 'Hockey', 'Rugby', 'American Football', 'MMA', 'Golf', 'Darts', 'Other'], isRequired: false },
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false }
    ] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [
      { name: 'genre', options: ['Football', 'Cricket', 'Basketball', 'Motorsport', 'Tennis', 'Baseball', 'Hockey', 'Rugby', 'American Football', 'MMA', 'Golf', 'Darts', 'Other'], isRequired: false },
      { name: 'skip', isRequired: false }
    ] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_teams', name: '⭐ Your Teams', extra: [{ name: 'search', isRequired: false }] },

    { type: SPORTS_TYPE, id: 'nuvio_sports_football', name: '⚽ Soccer', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_cricket', name: '🏏 Cricket', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_basketball', name: '🏀 Basketball', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_motorsport', name: '🏎️ F1 & Motor', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_hockey', name: '🏒 Hockey', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_baseball', name: '⚾ Baseball', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_mma', name: '🥊 MMA', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_golf', name: '⛳ Golf', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_tennis', name: '🎾 Tennis', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_rugby', name: '🏉 Rugby', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_american_football', name: '🏈 American Football', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_darts', name: '🎯 Darts', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_college', name: '🎓 College Sports', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_other', name: '🏅 Other Sports', extra: [{ name: 'skip', isRequired: false }] },

    // Per-sport replay rows (filtered by the Sports selector)
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_football', name: '⚽ Football Replays', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_motorsport', name: '🏎️ Motorsport Replays', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_baseball', name: '⚾ Baseball Replays', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_rugby', name: '🏉 Rugby Replays', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_basketball', name: '🏀 Basketball Replays', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_tennis', name: '🎾 Tennis Replays', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_hockey', name: '🏒 Hockey Replays', extra: [{ name: 'skip', isRequired: false }] },
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays_american_football', name: '🏈 American Football Replays', extra: [{ name: 'skip', isRequired: false }] },
    // Replay hub (one tile per sport); reached from search/discover, not a home row
    { type: SPORTS_TYPE, id: 'nuvio_sports_replays', name: '⏪ Sports Replays', extra: [{ name: 'skip', isRequired: true }] },

    // ── 24/7 networks stay in the standard TV channels section ──
    { type: 'tv', id: 'nuvio_sports_networks', name: '📺 24/7 Live TV', extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false }
    ] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' },
    { 
      key: 'timezone', 
      title: 'Timezone', 
      type: 'text',
      default: 'UTC'
    },
    // Preferred commentary languages, in order. Names or codes both work
    // ("Spanish, Arabic, Hindi", "es, ar, hi"); English is always ranked first
  // regardless.
    { key: 'languages', title: 'Preferred Languages (comma separated, English always first)', type: 'text' },
    // 'all' (default) lists every replay; 'mainstream' hides niche and
    // lower-division fixtures from the replay catalogs and hubs.
    { key: 'replayFilter', title: 'Replay Catalog (all or mainstream)', type: 'select', options: ['all', 'mainstream'], default: 'all' },
    { key: 'liveSources', title: 'Live & TV Sources (comma separated)', type: 'text', default: 'all' },
    { key: 'replaySources', title: 'Replay & VOD Sources (comma separated)', type: 'text', default: 'all' },
    { key: 'sources', title: 'All Sources (legacy, comma separated)', type: 'text', default: 'all' },
    { key: 'madplayUrl', title: 'MadPlay Base URL', type: 'text' }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },

  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..F6aEbE6t6R_hibs0MWTXdw.T0iVZbTb3-Cn9MUDoIic5yovMLCxjssPZHs2meJgSbTBXVegWV0j27ZCkIi60pNbuxEy2tQXHxbVytxthyD4GozD5DCzDnpdUcWQOmhd4IQs37WQxp7-neyrt9aeLP_N.XRyLWSFHcEupa3FTtsh_eA'
  },
};

const builder = new addonBuilder(manifest);

module.exports = { builder, manifest };
