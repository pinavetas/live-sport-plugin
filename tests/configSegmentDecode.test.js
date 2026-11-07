'use strict';

const http = require('http');
const express = require('express');
const { decodeConfigSegment } = require('../src/configSegment');

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

describe('decodeConfigSegment', () => {
  const withPercent = { sports: 'football', proxyUrl: 'https://proxy.example.invalid/a%20b?d=50%' };

  test('already-decoded JSON keeps a literal "%" in a value', () => {
    // What Express hands over for a %7B...%7D segment.
    expect(decodeConfigSegment(JSON.stringify(withPercent))).toEqual(withPercent);
  });

  test('URL-encoded JSON (encoded twice in the URL) is decoded once', () => {
    expect(decodeConfigSegment(encodeURIComponent(JSON.stringify(withPercent)))).toEqual(withPercent);
    expect(decodeConfigSegment(encodeURIComponent(JSON.stringify({ a: 1 })).replace('%7B', '%7b'))).toEqual({ a: 1 });
  });

  test('base64url JSON still decodes, including values with "%"', () => {
    expect(decodeConfigSegment(b64url({ sports: 'all' }))).toEqual({ sports: 'all' });
    expect(decodeConfigSegment(b64url(withPercent))).toEqual(withPercent);
  });

  test('JSON that is still partially encoded falls back to one more decode', () => {
    expect(decodeConfigSegment('{%22sports%22:%22all%22}')).toEqual({ sports: 'all' });
  });

  test('invalid input returns null', () => {
    expect(decodeConfigSegment('')).toBeNull();
    expect(decodeConfigSegment(undefined)).toBeNull();
    expect(decodeConfigSegment('[1,2]')).toBeNull();
    expect(decodeConfigSegment('{not json')).toBeNull();
    expect(decodeConfigSegment('%7Bbroken%')).toBeNull();
    expect(decodeConfigSegment('not-base64-json')).toBeNull();
  });
});

describe('config segment through an Express route param', () => {
  let server;
  let port;

  beforeAll((done) => {
    const app = express();
    app.get('/:config/manifest.json', (req, res) => {
      res.json({ config: decodeConfigSegment(req.params.config) });
    });
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  function getConfig(segment) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/${segment}/manifest.json` }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(JSON.parse(body).config));
      }).on('error', reject);
    });
  }

  test('a %7B-JSON config with a "%" in a URL value survives', async () => {
    const config = { sports: 'football', mediaflowUrl: 'https://mf.example.invalid/proxy?api_password=p%40ss%' };
    await expect(getConfig(encodeURIComponent(JSON.stringify(config)))).resolves.toEqual(config);
  });

  test('a base64url config is unaffected', async () => {
    const config = { sports: 'cricket', languages: 'en,es' };
    await expect(getConfig(b64url(config))).resolves.toEqual(config);
  });
});
