const http = require('http');
const express = require('express');
const { extractYouTubeVideoId, youtubeWatchUrl } = require('../src/services/YouTubeRedirect');

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe('extractYouTubeVideoId', () => {
  it.each([
    [ID],
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?feature=share&v=${ID}`],
    [`http://m.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/embed/${ID}?autoplay=1`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/live/${ID}`],
    [`https://youtu.be/${ID}?t=30`],
    [`youtube.com/watch?v=${ID}`],
    [`//www.youtube.com/embed/${ID}`]
  ])('extracts the id from %p', (input) => {
    expect(extractYouTubeVideoId(input)).toBe(ID);
  });

  it.each([
    'https://evil.com/youtube.com',
    `https://evil.com/youtube.com/watch?v=${ID}`,
    `https://youtube.com@evil.com/watch?v=${ID}`,
    `https://user:pw@www.youtube.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://evil-youtube.com/watch?v=${ID}`,
    `https://evil.com/?u=youtu.be/${ID}`,
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ/../x',
    'https://www.youtube.com/playlist?list=PL123',
    'not-an-id',
    '',
    null,
    ['array']
  ])('rejects %p', (input) => {
    expect(extractYouTubeVideoId(input)).toBeNull();
  });

  it('youtubeWatchUrl only builds a canonical URL from a valid id', () => {
    expect(youtubeWatchUrl(ID)).toBe(CANONICAL);
    expect(youtubeWatchUrl('evil.com/x')).toBeNull();
    expect(youtubeWatchUrl(null)).toBeNull();
  });
});

describe('/watch redirect handling', () => {
  let server, port;

  beforeAll((done) => {
    const app = express();
    app.use(require('../src/routes/watch'));
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });

  afterAll((done) => { server.close(done); });

  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    }).on('error', reject);
  });

  const q = encodeURIComponent;

  it.each([
    `/watch?url=${q(`https://www.youtube.com/watch?v=${ID}`)}`,
    `/watch?url=${q(`https://youtu.be/${ID}`)}`,
    `/watch?url=${q(`https://www.youtube.com/embed/${ID}`)}&title=Match`,
    `/watch?ytId=${ID}`,
    `/watch?v=${ID}`,
    `/watch?url=${q(`https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${ID}`)}`
  ])('redirects legitimate YouTube input %p to the canonical watch URL', async (path) => {
    const r = await get(path);
    expect(r.status).toBe(302);
    expect(r.location).toBe(CANONICAL);
  });

  it.each([
    `/watch?url=${q('https://evil.com/youtube.com')}`,
    `/watch?url=${q(`https://youtube.com@evil.com/watch?v=${ID}`)}`,
    `/watch?url=${q(`https://evil.com/youtube.com/watch?v=${ID}`)}`,
    `/watch?url=${q('https://evil.com/youtu%2Ebe')}`,
    `/watch?ytId=${q('evil.com')}`,
    `/watch?v=${q('//evil.com')}`,
    `/watch?foo=${q('youtube.com@evil.com')}`,
    `/watch?foo=youtube.com@evil.com`
  ])('never redirects attacker-controlled input %p off YouTube', async (path) => {
    const r = await get(path);
    if (r.location) {
      expect(r.location).toBe(CANONICAL);
    }
    expect(r.status).toBe(400);
    expect(r.body).not.toMatch(/evil\.com/);
  });

  it('still serves the iframe player page for a normal embed URL', async () => {
    const r = await get(`/watch?url=${q('https://embed.example.com/stream/1')}&title=Match`);
    expect(r.status).toBe(200);
    expect(r.location).toBeUndefined();
    expect(r.body).toContain('https://embed.example.com/stream/1');
  });

  it('still serves the extract page for mode=extract', async () => {
    const r = await get(`/watch?mode=extract&embed=${q('https://embed.example.com/e/1')}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Extracting Stream');
  });

  it('keeps the "No Stream URL" page when no url is given', async () => {
    const r = await get('/watch');
    expect(r.status).toBe(400);
    expect(r.body).toContain('No Stream URL Provided');
  });
});
