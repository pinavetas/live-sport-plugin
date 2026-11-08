'use strict';

const http = require('http');
const express = require('express');
const { createReplaySubcatalogHandler, parseExtraSegment } = require('../src/routes/replaySubcatalogs');

const ROUTES = [
  '/catalog/:type/:id.json',
  '/catalog/:type/:id/:extra.json',
  '/:config/catalog/:type/:id.json',
  '/:config/catalog/:type/:id/:extra.json'
];

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('request hung')));
    req.on('error', reject);
  });
}

describe('parseExtraSegment', () => {
  test('keeps everything after the first "=" in a value', () => {
    expect(parseExtraSegment('search=a=b&skip=20')).toEqual({ search: 'a=b', skip: '20' });
  });

  test('a malformed escape only affects its own value', () => {
    expect(parseExtraSegment('search=100%&skip=20&genre=Foo%20Bar')).toEqual({
      search: '100%',
      skip: '20',
      genre: 'Foo Bar'
    });
  });

  test('an encoded "&" stays inside its value', () => {
    expect(parseExtraSegment('genre=A%26B&skip=0')).toEqual({ genre: 'A&B', skip: '0' });
  });

  test('empty and key-less pairs are ignored', () => {
    expect(parseExtraSegment('')).toEqual({});
    expect(parseExtraSegment('=x&skip=&a')).toEqual({});
  });
});

describe('nuvio_sports_replays_* direct handler', () => {
  let server;
  let port;
  const handleCatalog = jest.fn();
  const decodeConfigSegment = jest.fn(() => ({ fromConfig: true }));
  const applyCompactParams = jest.fn((target) => (target && typeof target === 'object' ? target : {}));
  let errorSpy;

  beforeAll((done) => {
    const app = express();
    app.get(ROUTES, createReplaySubcatalogHandler({ handleCatalog, decodeConfigSegment, applyCompactParams }));
    app.use((req, res) => res.status(404).json({ fellThrough: true }));
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    handleCatalog.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { errorSpy.mockRestore(); });

  test('a throwing handleCatalog answers 200 with an empty page instead of hanging', async () => {
    handleCatalog.mockRejectedValue(new Error('boom'));

    const res = await get(port, '/catalog/tv/nuvio_sports_replays_football_today/skip=20.json');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ metas: [] });
    expect(res.headers['cache-control']).toBe('max-age=30, public');
  });

  test('passes every extra through, including values with "=" and a stray "%"', async () => {
    handleCatalog.mockResolvedValue({ metas: [{ id: 'x' }], cacheMaxAge: 60 });

    const res = await get(port, '/catalog/tv/nuvio_sports_replays_football_today/search=a%3Db%3Dc&genre=100%25&skip=20.json');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ metas: [{ id: 'x' }], cacheMaxAge: 60 });
    expect(res.headers['cache-control']).toBe('max-age=60, stale-while-revalidate=120, public');
    const [type, id, extra, config] = handleCatalog.mock.calls[0];
    expect(type).toBe('tv');
    expect(id).toBe('nuvio_sports_replays_football_today');
    expect(extra).toEqual({ search: 'a=b=c', genre: '100%', skip: '20' });
    expect(config).toEqual({});
  });

  test('decodes the config segment when present', async () => {
    handleCatalog.mockResolvedValue({ metas: [] });

    await get(port, '/abc123/catalog/tv/nuvio_sports_replays_football_today.json');

    expect(decodeConfigSegment).toHaveBeenCalledWith('abc123');
    expect(handleCatalog.mock.calls[0][3]).toEqual({ fromConfig: true });
  });

  test('other catalogs fall through to the next handler', async () => {
    const res = await get(port, '/catalog/tv/nuvio_sports_replays.json');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ fellThrough: true });
    expect(handleCatalog).not.toHaveBeenCalled();
  });
});
