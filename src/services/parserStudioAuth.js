/**
 * parserStudioAuth.js - access gate for the /api/parser/* (AI Parser Studio) API.
 *
 * The studio can spend the server's AI_API_KEY, fetch arbitrary URLs and mount
 * new providers at runtime, and the app enables CORS for every origin, so it
 * must never be reachable anonymously from the internet.
 *
 * A request is allowed when EITHER:
 *   1. it is a direct local request (no forwarding headers, loopback/LAN peer -
 *      see localRequest.js), or
 *   2. PARSER_STUDIO_TOKEN is set and the caller presents it in the
 *      `x-parser-studio-token` header or the `?token=` query parameter.
 *
 * With PARSER_STUDIO_TOKEN unset only local direct requests get through.
 * Everything else receives 401.
 */
'use strict';

const crypto = require('crypto');
const { isLocalDirectRequest } = require('./localRequest');

const TOKEN_ENV = 'PARSER_STUDIO_TOKEN';
const TOKEN_HEADER = 'x-parser-studio-token';

function presentedToken(req) {
  const header = req.headers && req.headers[TOKEN_HEADER];
  if (typeof header === 'string' && header) return header;
  const query = req.query && req.query.token;
  if (typeof query === 'string' && query) return query;
  return '';
}

// Hash both sides first so timingSafeEqual always compares equal-length buffers
// and the comparison time does not leak the token length.
function tokensMatch(presented, expected) {
  const a = crypto.createHash('sha256').update(String(presented)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function isParserStudioAuthorized(req, env = process.env) {
  if (isLocalDirectRequest(req)) return true;
  const expected = env[TOKEN_ENV];
  if (!expected) return false;
  const presented = presentedToken(req);
  return Boolean(presented) && tokensMatch(presented, expected);
}

function parserStudioAuth(req, res, next) {
  if (isParserStudioAuthorized(req)) return next();
  return res.status(401).json({
    success: false,
    error: 'Unauthorized',
    reason: process.env[TOKEN_ENV] ? 'invalid_token' : 'local_only',
  });
}

module.exports = { parserStudioAuth, isParserStudioAuthorized, TOKEN_ENV, TOKEN_HEADER };
