/**
 * CollectionPoster.js
 *
 * Path resolution for /img/collection/:sport. The route parameter is
 * URL-decoded by Express, so an encoded `..%2F` arrives as `../` and, joined
 * straight into a filesystem path, lets a caller read any `.jpg` on disk.
 * The key is whitelisted and every candidate is re-checked to stay inside its
 * collections directory.
 */

const path = require('path');
const fs = require('fs');

const SPORT_KEY_RE = /^[a-z0-9_-]+$/i;

/**
 * Normalise a raw route parameter into a collection key.
 * @param {string} raw
 * @returns {string|null} lower-cased key, or null when it is not a safe key
 */
function normalizeCollectionSport(raw) {
  const value = String(raw == null || raw === '' ? 'football' : raw)
    .toLowerCase()
    .replace(/\.(jpg|jpeg|png|svg)$/i, '');
  return SPORT_KEY_RE.test(value) ? value : null;
}

/**
 * First existing `<dir>/<sport>.jpg`, constrained to stay within `<dir>`.
 * @param {string} sport  key already validated by normalizeCollectionSport
 * @param {string[]} dirs collections directories, in priority order
 * @param {(p:string)=>boolean} [exists]
 * @returns {string|null}
 */
function findCollectionPoster(sport, dirs, exists = fs.existsSync) {
  if (!sport || !SPORT_KEY_RE.test(sport)) return null;
  for (const dir of dirs) {
    const root = path.resolve(dir);
    const candidate = path.resolve(root, `${sport}.jpg`);
    if (path.dirname(candidate) !== root) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

module.exports = { normalizeCollectionSport, findCollectionPoster, SPORT_KEY_RE };
