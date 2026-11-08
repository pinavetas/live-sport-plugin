/**
 * safeJsLiteral.js - evaluate a JavaScript *literal* expression WITHOUT running code.
 *
 * Scraped SPA pages embed their state as JS object literals (e.g.
 * `window.ftbPageData = { schedule: [...] }`). Those literals are not always strict
 * JSON (unquoted keys, single quotes, trailing commas, `undefined`), so JSON.parse is
 * not enough - but evaluating third-party text with `new Function` / `eval` is remote
 * code execution. This helper parses the text with acorn and builds the value by
 * walking the AST, accepting ONLY pure data nodes:
 *
 *   ObjectExpression (plain, non-computed `key: value` properties)
 *   ArrayExpression (no holes, no spread)
 *   Literal (string / number / boolean / null; regex and bigint rejected)
 *   TemplateLiteral without ${} expressions
 *   UnaryExpression `-` / `+` applied to a numeric literal
 *   Identifier `undefined`, `NaN`, `Infinity`
 *
 * Anything else (calls, member access, identifiers such as `process`, functions,
 * getters, spreads, computed keys, assignments, ...) throws, so nothing in the
 * payload is ever executed.
 */
'use strict';

const acorn = require('acorn');

const MAX_DEPTH = 200;

class UnsafeLiteralError extends Error {}

function fail(node, why) {
  throw new UnsafeLiteralError(`safeJsLiteral: ${why} (${node && node.type})`);
}

function propertyKey(prop) {
  if (prop.computed) fail(prop, 'computed key not allowed');
  const key = prop.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value);
  }
  return fail(key, 'unsupported property key');
}

function build(node, depth) {
  if (depth > MAX_DEPTH) fail(node, 'nesting too deep');

  switch (node.type) {
    case 'ObjectExpression': {
      const out = {};
      for (const prop of node.properties) {
        if (prop.type !== 'Property' || prop.kind !== 'init' || prop.method) {
          fail(prop, 'only plain key: value properties are allowed');
        }
        // defineProperty so a `__proto__` key stays an own data property instead of
        // re-pointing the prototype of the result.
        Object.defineProperty(out, propertyKey(prop), {
          value: build(prop.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }

    case 'ArrayExpression':
      return node.elements.map((el) => {
        if (!el) fail(node, 'array holes not allowed');
        return build(el, depth + 1);
      });

    case 'Literal':
      if (node.regex || typeof node.bigint === 'string') fail(node, 'regex/bigint literal not allowed');
      return node.value;

    case 'TemplateLiteral':
      if (node.expressions.length > 0) fail(node, 'template expressions not allowed');
      return node.quasis.map((q) => q.value.cooked).join('');

    case 'UnaryExpression': {
      if (node.operator !== '-' && node.operator !== '+') fail(node, `operator ${node.operator} not allowed`);
      const arg = node.argument;
      const isNumeric = (arg.type === 'Literal' && typeof arg.value === 'number')
        || (arg.type === 'Identifier' && (arg.name === 'Infinity' || arg.name === 'NaN'));
      if (!isNumeric) fail(node, 'unary operator only allowed on numbers');
      const value = build(arg, depth + 1);
      return node.operator === '-' ? -value : value;
    }

    case 'Identifier':
      if (node.name === 'undefined') return undefined;
      if (node.name === 'NaN') return NaN;
      if (node.name === 'Infinity') return Infinity;
      return fail(node, `identifier "${node.name}" not allowed`);

    default:
      return fail(node, 'node type not allowed');
  }
}

/**
 * Parse `source` as a single JS expression and return its literal value.
 * Throws if the text is not a pure data literal.
 *
 * @param {string} source
 * @returns {*}
 */
function parseJsLiteral(source) {
  if (typeof source !== 'string') throw new UnsafeLiteralError('safeJsLiteral: source must be a string');
  const ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' });
  // parseExpressionAt stops at the end of the first expression; anything after it
  // (other than whitespace / a trailing semicolon) means the text was not a lone literal.
  const rest = source.slice(ast.end);
  if (!/^\s*;?\s*$/.test(rest)) throw new UnsafeLiteralError('safeJsLiteral: trailing content after literal');
  return build(ast, 0);
}

module.exports = { parseJsLiteral, UnsafeLiteralError };
