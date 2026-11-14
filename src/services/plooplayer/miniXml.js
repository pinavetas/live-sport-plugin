'use strict';

/**
 * miniXml — a dependency-free XML parser that reproduces the object shape
 * DashToHlsService gets from fast-xml-parser with its options:
 *
 *   { ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: true,
 *     isArray: name => ALWAYS_ARRAY_TAGS.has(name) }   (+ library defaults:
 *   parseTagValue, trimValues, processEntities)
 *
 * It exists so the Plooplayer local decryptor runs on a TV under Termux with
 * node core modules only. Scope is MPEG-DASH manifests: elements, attributes,
 * text, CDATA, comments, processing instructions and the XML entities. DTDs and
 * custom entities are ignored. tests/plooplayerMiniXml.test.js pins parity with
 * fast-xml-parser on DASH manifests.
 */

// Sticky: every token must start where the previous one ended, so a malformed
// tag is an error instead of being silently skipped.
const TOKEN_RX = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[^\]]*\])*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
const ATTR_RX = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY_RX = /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g;
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const DECIMAL_RX = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const HEX_RX = /^0x[0-9a-fA-F]+$/;

function decodeEntities(value) {
  return value.replace(ENTITY_RX, (match, named, dec, hex) => {
    if (named) return NAMED_ENTITIES[named];
    const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    try {
      return String.fromCodePoint(code);
    } catch (_) {
      return match;
    }
  });
}

/** fast-xml-parser's parseValue(): booleans, numbers that survive a round trip, else the string. */
function parseValue(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (HEX_RX.test(value)) return parseInt(value, 16);
  if (!DECIMAL_RX.test(value)) return raw;
  const num = Number(value);
  if (!Number.isFinite(num)) return raw;
  if (/^[-+]?\d+$/.test(value) && !Number.isSafeInteger(num)) return raw; // precision would be lost
  return num;
}

function addChild(target, name, value, isArray) {
  if (isArray(name)) {
    (target[name] = target[name] || []).push(value);
  } else if (Object.prototype.hasOwnProperty.call(target, name)) {
    if (!Array.isArray(target[name])) target[name] = [target[name]];
    target[name].push(value);
  } else {
    target[name] = value;
  }
}

function finalize(frame) {
  const text = frame.text.trim();
  const hasAttrs = frame.attrs.length > 0;
  if (!hasAttrs && !frame.hasChildren) return text === '' ? '' : parseValue(text);
  const node = frame.children;
  for (const [name, value] of frame.attrs) node[`@_${name}`] = parseValue(decodeEntities(value));
  if (text !== '') node['#text'] = parseValue(text);
  return node;
}

/**
 * @param {string} xml
 * @param {{isArray?: (name: string) => boolean}} [options]
 * @returns {object}
 */
function parseXml(xml, options = {}) {
  if (typeof xml !== 'string') throw new Error('XML input must be a string');
  const isArray = typeof options.isArray === 'function' ? options.isArray : () => false;
  const root = { children: {}, attrs: [], text: '', hasChildren: false };
  const stack = [root];
  TOKEN_RX.lastIndex = 0;
  while (TOKEN_RX.lastIndex < xml.length) {
    const at = TOKEN_RX.lastIndex;
    const match = TOKEN_RX.exec(xml);
    if (!match) throw new Error(`XML parse error: malformed markup at offset ${at}`);
    const [, cdata, closeName, openName, attrText, selfClose, text] = match;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      top.text += decodeEntities(text);
    } else if (cdata !== undefined) {
      top.text += cdata;
    } else if (openName !== undefined) {
      const attrs = [];
      ATTR_RX.lastIndex = 0;
      let a;
      while ((a = ATTR_RX.exec(attrText || '')) !== null) attrs.push([a[1], a[2] !== undefined ? a[2] : a[3]]);
      const frame = { name: openName, children: {}, attrs, text: '', hasChildren: false };
      if (selfClose) {
        top.hasChildren = true;
        addChild(top.children, openName, finalize(frame), isArray);
      } else {
        stack.push(frame);
      }
    } else if (closeName !== undefined) {
      if (stack.length <= 1 || top.name !== closeName) {
        throw new Error(`XML parse error: unexpected </${closeName}>`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      parent.hasChildren = true;
      addChild(parent.children, closeName, finalize(top), isArray);
    }
    // comments, processing instructions and DOCTYPE carry nothing we need
  }
  if (stack.length !== 1) throw new Error(`XML parse error: unclosed <${stack[stack.length - 1].name}>`);
  return root.children;
}

/** Drop-in for the `{ parse }` object DashToHlsService expects. */
function createMiniXmlParser(options = {}) {
  return { parse: (xml) => parseXml(xml, options) };
}

module.exports = { parseXml, createMiniXmlParser };
