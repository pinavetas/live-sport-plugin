'use strict';

function isConfigObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
}

/**
 * Decodes a config URL segment. Accepts JSON (as Express hands it over after
 * decoding the route param), URL-encoded JSON, or base64url JSON.
 * Returns null when the segment is not a valid config.
 *
 * Callers pass req.params.config, which Express has ALREADY percent-decoded.
 * Decoding it again unconditionally turned a literal "%" in any config value
 * (e.g. inside a URL) into a URIError and silently reset the config, so the
 * already-decoded text is tried first and a further decode is only a fallback.
 */
function decodeConfigSegment(configStr) {
  if (typeof configStr !== 'string' || !configStr) return null;
  try {
    let parsed;
    if (configStr.startsWith('{')) {
      parsed = tryParseJson(configStr);
      if (parsed === undefined) parsed = JSON.parse(decodeURIComponent(configStr));
    } else if (/^%7B/i.test(configStr)) {
      // Still encoded (the URL was encoded twice): decode exactly once more.
      parsed = JSON.parse(decodeURIComponent(configStr));
    } else {
      let base64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) {
        base64 += '=';
      }
      parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    }
    return isConfigObject(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

module.exports = { decodeConfigSegment };
