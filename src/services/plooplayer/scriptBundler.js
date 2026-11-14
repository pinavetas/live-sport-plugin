'use strict';

/**
 * scriptBundler — concatenates a CommonJS entry and its relative requires into
 * one self-contained script, so the Plooplayer local decryptor can be installed
 * on a TV with a single `curl` (GET /plooplayer/decryptor.js) and no npm.
 *
 * Deliberately tiny, not a general bundler:
 *   - relative `require('./x')` calls are inlined (static string specifiers only);
 *   - node core modules stay native `require` calls;
 *   - `stubs` replaces a module with one that throws when loaded (used for code
 *     paths the decryptor never executes, e.g. the add-on's egress stack);
 *   - any other bare package must be listed in `allowExternal` (lazy requires
 *     that never run in the bundle), otherwise bundling fails loudly.
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const REQUIRE_RX = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
const BUILTINS = new Set(builtinModules);

function isBuiltin(spec) {
  return spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`scriptBundler: cannot resolve "${spec}" from ${fromFile}`);
}

/**
 * @param {string} entryFile
 * @param {object} opts
 * @param {string} opts.rootDir              module ids are paths relative to this
 * @param {string[]} [opts.stubs]            absolute paths replaced by throwing stubs
 * @param {string[]} [opts.allowExternal]    bare packages tolerated (left as native require)
 * @param {string[]} [opts.banner]           comment lines placed at the top
 * @returns {{ code: string, modules: string[], externals: string[] }}
 */
function bundleCommonJs(entryFile, opts) {
  const rootDir = path.resolve(opts.rootDir);
  const stubs = new Set((opts.stubs || []).map((p) => path.resolve(p)));
  const allowExternal = new Set(opts.allowExternal || []);
  const modules = new Map();
  const externals = new Set();
  const idOf = (abs) => path.relative(rootDir, abs).split(path.sep).join('/');

  const visit = (abs) => {
    if (modules.has(abs)) return;
    const entry = { id: idOf(abs), deps: {}, source: '' };
    modules.set(abs, entry);
    if (stubs.has(abs)) {
      entry.source = `throw new Error(${JSON.stringify(`${entry.id} is not part of the bundled script`)});`;
      return;
    }
    const source = fs.readFileSync(abs, 'utf8').replace(/^#!.*\r?\n/, '');
    entry.source = source;
    for (const match of source.matchAll(REQUIRE_RX)) {
      const spec = match[2];
      if (spec.startsWith('.')) {
        const dep = resolveLocal(abs, spec);
        entry.deps[spec] = idOf(dep);
        visit(dep);
      } else if (!isBuiltin(spec)) {
        if (!allowExternal.has(spec)) {
          throw new Error(`scriptBundler: ${entry.id} requires package "${spec}", which the bundle cannot carry`);
        }
        externals.add(spec);
      }
    }
  };

  const entryAbs = path.resolve(entryFile);
  visit(entryAbs);

  const out = ['#!/usr/bin/env node'];
  for (const line of opts.banner || []) out.push(`// ${line}`);
  out.push("'use strict';", '(function () {', 'const __defs = Object.create(null);');
  for (const entry of modules.values()) {
    out.push(`__defs[${JSON.stringify(entry.id)}] = [function (module, exports, require, __filename, __dirname) {`);
    out.push(entry.source);
    out.push(`}, ${JSON.stringify(entry.deps)}];`);
  }
  out.push(
    'const __cache = Object.create(null);',
    'function __load(id) {',
    '  if (__cache[id]) return __cache[id].exports;',
    '  const def = __defs[id];',
    '  const module = { id, exports: {} };',
    '  __cache[id] = module;',
    '  const localRequire = (spec) => (Object.prototype.hasOwnProperty.call(def[1], spec) ? __load(def[1][spec]) : require(spec));',
    "  def[0].call(module.exports, module, module.exports, localRequire, id, id.slice(0, id.lastIndexOf('/')));",
    '  return module.exports;',
    '}',
    `__load(${JSON.stringify(idOf(entryAbs))});`,
    '})();',
    ''
  );
  return { code: out.join('\n'), modules: [...modules.values()].map((m) => m.id), externals: [...externals] };
}

module.exports = { bundleCommonJs };
