const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { normalizeCollectionSport, findCollectionPoster } = require('../src/services/CollectionPoster');

describe('/img/collection/:sport path traversal', () => {
  let tmp, collectionsDir;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-poster-'));
    collectionsDir = path.join(tmp, 'public', 'posters', 'collections');
    fs.mkdirSync(collectionsDir, { recursive: true });
    fs.writeFileSync(path.join(collectionsDir, 'football.jpg'), 'poster');
    fs.writeFileSync(path.join(collectionsDir, 'motor_sport-2.jpg'), 'poster');
    fs.writeFileSync(path.join(tmp, 'secret.jpg'), 'secret');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('normalizeCollectionSport', () => {
    it('accepts plain keys, lower-cases them and strips an image extension', () => {
      expect(normalizeCollectionSport('Football')).toBe('football');
      expect(normalizeCollectionSport('football.jpg')).toBe('football');
      expect(normalizeCollectionSport('motor_sport-2.PNG')).toBe('motor_sport-2');
    });

    it('defaults to football when the parameter is empty', () => {
      expect(normalizeCollectionSport('')).toBe('football');
      expect(normalizeCollectionSport(undefined)).toBe('football');
    });

    it.each([
      '../secret',
      '../../../secret.jpg',
      '..\..\secret',
      'foo/bar',
      '/etc/passwd',
      'C:\secret',
      '..',
      'foot ball',
      'football%00'
    ])('rejects %p', (raw) => {
      expect(normalizeCollectionSport(raw)).toBeNull();
    });
  });

  describe('findCollectionPoster', () => {
    it('finds a legitimate poster', () => {
      expect(findCollectionPoster('football', [collectionsDir])).toBe(path.resolve(collectionsDir, 'football.jpg'));
    });

    it('never resolves outside the collections directory, even when called with an unvalidated key', () => {
      const exists = jest.fn(() => true);
      expect(findCollectionPoster('../../../secret', [collectionsDir], exists)).toBeNull();
      expect(exists).not.toHaveBeenCalled();
    });

    it('returns null when no candidate exists', () => {
      expect(findCollectionPoster('cricket', [collectionsDir])).toBeNull();
    });
  });

  describe('through an Express route (encoded ..%2F is decoded by Express)', () => {
    let server, port;

    beforeAll((done) => {
      const app = express();
      app.get('/img/collection/:sport', (req, res) => {
        const sport = normalizeCollectionSport(req.params.sport);
        if (!sport) return res.status(400).end();
        const p = findCollectionPoster(sport, [collectionsDir]);
        if (p) return res.sendFile(p);
        return res.status(404).end();
      });
      server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });

    afterAll((done) => { server.close(done); });

    const get = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });

    it('serves a legitimate poster', async () => {
      const r = await get('/img/collection/football.jpg');
      expect(r.status).toBe(200);
      expect(r.body).toBe('poster');
    });

    it('refuses an encoded traversal instead of serving a file outside the directory', async () => {
      const r = await get('/img/collection/..%2F..%2F..%2Fsecret.jpg');
      expect(r.status).toBe(400);
      expect(r.body).not.toContain('secret');
    });
  });

  it('the /img/collection route in index.js validates the key before touching the filesystem', () => {
    const source = fs.readFileSync(require.resolve('../src/index'), 'utf8');
    const start = source.indexOf("app.get(['/img/collection/:sport'");
    expect(start).toBeGreaterThan(-1);
    const route = source.slice(start, start + 1500);
    expect(route).toMatch(/normalizeCollectionSport\(req\.params\.sport\)/);
    expect(route).toMatch(/findCollectionPoster\(/);
    expect(route).not.toMatch(/`\$\{sport\}\.jpg`/);
  });
});
