'use strict';

const http = require('http');
const express = require('express');
const { createPlooplayerRouter } = require('../src/routes/plooplayer');
const { createColdStartGate } = require('../src/serverless');

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Plooplayer routes', () => {
  let server;
  let base;
  const service = {
    catalog: jest.fn(async () => ({ metas: [{ id: 'ploo_a__b', type: 'Plooplayer', name: 'B' }], cacheMaxAge: 600, staleRevalidate: 3600 })),
    meta: jest.fn(async () => ({ meta: { id: 'ploo_a__b' }, cacheMaxAge: 600 })),
    streams: jest.fn(async () => ({ streams: [{ url: 'http://127.0.0.1:8090/ploo/index.m3u8?d=x' }], cacheMaxAge: 60 }))
  };
  const config = { plooplayerList: 'https://lists.example/raw' };

  beforeAll(async () => {
    const app = express();
    app.use(createPlooplayerRouter({ getService: () => service }));
    app.use((req, res) => res.status(404).send('fell through'));
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  test('catalog: config and extra reach the service; cache headers come from the result', async () => {
    const res = await fetch(`${base}/${b64url(config)}/catalog/Plooplayer/ploo_a/genre=Opcion%201%20%E2%80%BA%20DAZN&skip=100.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('max-age=600, stale-while-revalidate=3600, public');
    expect(await res.json()).toEqual({ metas: [{ id: 'ploo_a__b', type: 'Plooplayer', name: 'B' }] });
    expect(service.catalog).toHaveBeenLastCalledWith({ id: 'ploo_a', extra: { genre: 'Opcion 1 › DAZN', skip: '100' }, config });
  });

  test('stream receives the public request origin for the configure link', async () => {
    const res = await fetch(`${base}/${encodeURIComponent(JSON.stringify(config))}/stream/Plooplayer/ploo_a__b.json`, {
      headers: { 'X-Forwarded-Host': 'addon.example', 'X-Forwarded-Proto': 'https' }
    });
    expect(res.status).toBe(200);
    expect((await res.json()).streams).toHaveLength(1);
    expect(service.streams).toHaveBeenLastCalledWith({ id: 'ploo_a__b', config, baseUrl: 'https://addon.example' });
  });

  test('other types fall through to the regular handlers', async () => {
    const res = await fetch(`${base}/${b64url(config)}/catalog/Sports/nuvio_sports_live.json`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('fell through');
  });

  test('a failing service answers an empty, briefly cached payload', async () => {
    service.meta.mockRejectedValueOnce(new Error('boom'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(`${base}/${b64url(config)}/meta/Plooplayer/ploo_a__b.json`);
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ meta: null });
    expect(res.headers.get('cache-control')).toMatch(/^max-age=30,/);
  });

  test('serves the local decryptor as one runnable script', async () => {
    const res = await fetch(`${base}/plooplayer/decryptor.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const code = await res.text();
    expect(code.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(code).toContain('services/cenc/segment.js');
  });
});

describe('cold start gate', () => {
  test('Plooplayer requests never wait for the sports catalog sync', async () => {
    const cronService = { syncNow: jest.fn(() => new Promise(() => {})), inflightSync: null };
    const cacheService = { getMatchesReadOnly: () => [] };
    const next = jest.fn();
    const res = { on: () => {} };
    await createColdStartGate({ cronService, cacheService, maxWaitMs: 50 })({ path: '/abc/catalog/Plooplayer/ploo_x.json' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(cronService.syncNow).not.toHaveBeenCalled();
  });
});
