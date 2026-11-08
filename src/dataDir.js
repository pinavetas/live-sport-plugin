'use strict';

const path = require('path');

/**
 * Runtime data directory for files the process writes and must keep across
 * builds/restarts (matches cache, persisted state): DATA_DIR when set,
 * otherwise <cwd>/data.
 *
 * Why the working directory is a parameter: the production bundle
 * (@vercel/ncc, `npm run build`) statically rewrites both
 * `path.join(__dirname, ...)` and a literal `path.join(process.cwd(), 'data')`
 * into `dist/` assets, copying whatever was in the local ./data folder at build
 * time into the bundle. Writes then land inside dist/ (wiped by every build)
 * and dev and prod read different files. Passing cwd in as an argument keeps
 * the expression opaque to the asset relocator, so it is resolved at runtime.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 * @returns {string}
 */
function getDataDir(env = process.env, cwd = process.cwd()) {
  const fromEnv = env && typeof env.DATA_DIR === 'string' ? env.DATA_DIR.trim() : '';
  return fromEnv || path.join(cwd, 'data');
}

module.exports = { getDataDir };
