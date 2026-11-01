'use strict';

const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const DashToHlsService = require('../src/services/DashToHlsService');
const dashRouter = require('../src/routes/dash');

const NITRO_MPD_URL = 'https://otte.live.fly.ww.aiv-cdn.net/fra-nitro/out/v1/ab9d1f/cenc.mpd';
const AKAMAI_MPD_URL = 'https://akamai-edge.example.com/dash/live/tennis/manifest.mpd';
const KEY_HEX = 'ca0b64b84edb4f20eb1e135ff03db4f7';
const KID_HEX = '18e6af4a0daf2a1fdfbdc5b541520c88';

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function makeService(xmlByHost) {
  return new DashToHlsService({
    fetcher: async (url) => {
      for (const [host, xml] of Object.entries(xmlByHost)) {
        if (url.includes(host)) return { ok: true, status: 200, text: async () => xml };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });
}

function makePayload(mpdUrl) {
  return { mpdUrl, key: KEY_HEX, kid: KID_HEX, headers: {} };
}

describe('DashToHlsService (zero-bandwidth DASH→HLS converter)', () => {
  let nitroXml;
  let akamaiXml;

  beforeAll(() => {
    nitroXml = readFixture('nitro-live.mpd');
    akamaiXml = readFixture('akamai-live.mpd');
  });

  describe('MPD parsing (real Amazon Nitro live manifest)', () => {
    test('extracts video/audio representations from the live (last) period', () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const parsed = svc.parseMpd(nitroXml, NITRO_MPD_URL);

      expect(parsed.videoReps.length).toBe(6);
      expect(parsed.audioReps.length).toBe(1);
      expect(parsed.videoReps[0].bandwidth).toBe(8200000); // highest first
      expect(parsed.videoReps[0].codecs).toBe('avc1.640028');
      expect(parsed.audioReps[0].lang).toBe('hin');
    });

    test('detects cenc protection → SAMPLE-AES-CTR and keeps CDN token params', () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const parsed = svc.parseMpd(nitroXml, NITRO_MPD_URL);

      expect(parsed.videoReps[0].encryption).toBe('SAMPLE-AES-CTR');
      expect(parsed.audioReps[0].encryption).toBe('SAMPLE-AES-CTR');
      expect(parsed.videoReps[0].initUrl).toContain('https://otte.live.fly.ww.aiv-cdn.net/');
      expect(parsed.videoReps[0].initUrl).toMatch(/cenc_video_6_0_init\.mp4\?m=\d+$/);
    });

    test('caps the live window and indexes MEDIA-SEQUENCE from DASH $Number$', () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const parsed = svc.parseMpd(nitroXml, NITRO_MPD_URL);
      const video = parsed.videoReps[0];
      const audio = parsed.audioReps[0];

      expect(video.segments.length).toBeLessThanOrEqual(15);
      expect(audio.segments.length).toBeLessThanOrEqual(15);
      // Timeline startNumber=8522, 43 published segments → window ends at 8564
      expect(video.segments[0].number).toBe(8550);
      expect(video.segments[video.segments.length - 1].number).toBe(8564);
      expect(video.segments[0].url).toContain('cenc_video_6_0_8550.mp4');
    });
  });

  test('bounds materialized segments for very large SegmentTimeline repeats', () => {
    const xml = `<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000"><SegmentTemplate media="seg-$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="1" r="1000000"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
    const svc = new DashToHlsService({});
    const parsed = svc.parseMpd(xml, 'https://example.com/manifest.mpd');
    const segments = parsed.videoReps[0].segments;

    expect(segments).toHaveLength(15);
    expect(segments[0].number).toBe(999987);
    expect(segments[14].number).toBe(1000001);
    expect(segments[0].url).toContain('seg-999987.m4s');
  });

  describe('HLS rendering', () => {
    const reqBase = 'http://192.168.1.50:7000';
    const dRaw = Buffer.from(JSON.stringify(makePayload(NITRO_MPD_URL))).toString('base64url');

    test('master playlist: audio rendition group + fMP4 variant with payload-carrying child URLs', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const master = await svc.buildMaster(makePayload(NITRO_MPD_URL), dRaw, reqBase);

      expect(master).toContain('#EXT-X-VERSION:7');
      expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"');
      expect(master).toContain('LANGUAGE="hin"');
      expect(master).toMatch(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,CODECS="avc1\.640028,mp4a\.40\.2",RESOLUTION=1920x1080,AUDIO="aud"/);
      expect(master).toContain(`${reqBase}/api/dash/video.m3u8?d=${dRaw}`);
      expect(master).toContain(`${reqBase}/api/dash/audio.m3u8?d=${dRaw}`);
    });

    test('video playlist: SAMPLE-AES-CTR key, CDN init map, direct CDN segments, no proxying', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const playlist = await svc.buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', dRaw, reqBase);
      const lines = playlist.split('\n');

      expect(playlist).toContain(`#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="${reqBase}/api/dash/key.ts?k=${KEY_HEX}",KEYFORMAT="identity"`);
      expect(playlist).toContain('#EXT-X-MAP:URI="https://otte.live.fly.ww.aiv-cdn.net/');
      expect(playlist).toMatch(/#EXT-X-MEDIA-SEQUENCE:8550/);
      expect(playlist).toMatch(/#EXT-X-TARGETDURATION:2/);

      const segmentUrls = lines.filter((l) => l.startsWith('http'));
      expect(segmentUrls.length).toBeGreaterThan(0);
      for (const url of segmentUrls) {
        expect(url.startsWith('https://otte.live.fly.ww.aiv-cdn.net/')).toBe(true);
        expect(url).not.toContain(reqBase);
      }
    });

    test('playlist window slides monotonically when the upstream timeline advances', async () => {
      // Bump every video representation's timeline (one entry per rep in the fixture)
      const slidXml = nitroXml.split('d="50000" r="41"').join('d="50000" r="42"');
      expect(slidXml).not.toBe(nitroXml);

      const before = await new DashToHlsService({ fetcher: async () => ({ ok: true, status: 200, text: async () => nitroXml }) })
        .buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', dRaw, reqBase);
      const after = await new DashToHlsService({ fetcher: async () => ({ ok: true, status: 200, text: async () => slidXml }) })
        .buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', dRaw, reqBase);

      const seqBefore = Number(before.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);
      const seqAfter = Number(after.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);
      expect(seqAfter).toBe(seqBefore + 1);

      const lastUrl = after.split('\n').filter((l) => l.startsWith('http')).pop();
      expect(lastUrl).toContain('_8565.mp4'); // new live-edge segment exposed
    });
  });

  describe('Akamai-style fixed-duration MPD (cbcs, $RepresentationID$, BaseURL)', () => {
    const reqBase = 'http://10.0.0.5:7000';
    const dRaw = Buffer.from(JSON.stringify(makePayload(AKAMAI_MPD_URL))).toString('base64url');

    function patchAvailability(xml, isoTime) {
      return xml.replace(/availabilityStartTime="[^"]*"/, `availabilityStartTime="${isoTime}"`);
    }

    test('derives the live window from wall clock and maps cbcs → SAMPLE-AES', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace('Z', '+00:00');
      const svc = makeService({ 'akamai-edge.example.com': patchAvailability(akamaiXml, twoHoursAgo) });

      const playlist = await svc.buildMediaPlaylist(makePayload(AKAMAI_MPD_URL), 'video', dRaw, reqBase);
      const seq = Number(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);

      expect(playlist).toContain('#EXT-X-KEY:METHOD=SAMPLE-AES,');
      expect(playlist).toContain('#EXT-X-MAP:URI="https://akamai-edge.example.com/dash/live/tennis/video_1080/init.mp4"');
      expect(seq).toBeGreaterThanOrEqual(700000);
      expect(playlist).toMatch(/video_1080\/\d+\.m4s/);
      expect(playlist.split('\n').filter((l) => l.startsWith('http')).length).toBeLessThanOrEqual(15);
    });

    test('emits nothing before the availability start (pre-live guard)', () => {
      const inOneHour = new Date(Date.now() + 3600 * 1000).toISOString().replace('Z', '+00:00');
      const svc = makeService({ 'akamai-edge.example.com': patchAvailability(akamaiXml, inOneHour) });
      expect(() => svc.parseMpd(patchAvailability(akamaiXml, inOneHour), AKAMAI_MPD_URL)).toThrow(/no video representations/i);
    });
  });

  describe('upstream header sanitization (Akamai 403s Dalvik UAs)', () => {
    test('prefers a non-Dalvik UA when both variants are present', () => {
      const svc = new DashToHlsService({});
      const headers = svc._sanitizeUpstreamHeaders({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 5)'
      });
      expect(headers['User-Agent']).toMatch(/Mozilla/);
    });

    test('replaces a Dalvik-only UA with the default browser UA and strips hop-by-hop headers', () => {
      const svc = new DashToHlsService({});
      const headers = svc._sanitizeUpstreamHeaders({
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13)',
        Host: 'evil.example.com',
        Connection: 'keep-alive',
        Referer: 'https://keep-me.example/'
      });
      expect(headers['User-Agent']).toMatch(/Mozilla/);
      expect(headers.Host).toBeUndefined();
      expect(headers.Connection).toBeUndefined();
      expect(headers.Referer).toBe('https://keep-me.example/');
    });
  });

  describe('HTTP routes (/api/dash/*)', () => {
    let server;
    let baseUrl;
    let svc;

    beforeAll((done) => {
      svc = makeService({ 'otte.live.fly': nitroXml });
      const app = express();
      app.use(dashRouter.createDashRouter(svc));
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
      });
    });

    afterAll((done) => {
      if (server) server.close(done);
      else done();
    });

    test('key.ts serves exactly 16 raw binary bytes of the AES key', async () => {
      const res = await fetch(`${baseUrl}/api/dash/key.ts?k=${KEY_HEX}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.length).toBe(16);
      expect(buf.toString('hex')).toBe(KEY_HEX);
    });

    test('key.ts rejects malformed keys', async () => {
      const res = await fetch(`${baseUrl}/api/dash/key.ts?k=zzz`);
      expect(res.status).toBe(400);
    });

    test('index/video/audio playlists serve HLS with no-store and payload passthrough', async () => {
      const d = Buffer.from(JSON.stringify(makePayload(NITRO_MPD_URL))).toString('base64url');

      const masterRes = await fetch(`${baseUrl}/api/dash/index.m3u8?d=${d}`);
      expect(masterRes.status).toBe(200);
      expect(masterRes.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
      expect(masterRes.headers.get('cache-control')).toBe('no-store');
      const master = await masterRes.text();
      expect(master).toContain('#EXT-X-STREAM-INF:');

      const videoRes = await fetch(`${baseUrl}/api/dash/video.m3u8?d=${d}`);
      expect(videoRes.status).toBe(200);
      const video = await videoRes.text();
      expect(video).toContain('#EXT-X-KEY:METHOD=SAMPLE-AES-CTR');
      expect(video).toContain('/api/dash/key.ts?k=');

      const audioRes = await fetch(`${baseUrl}/api/dash/audio.m3u8?d=${d}`);
      expect(audioRes.status).toBe(200);
      expect((await audioRes.text())).toContain('#EXTINF:');
    });

    test('rejects missing/invalid payloads with 400', async () => {
      const missing = await fetch(`${baseUrl}/api/dash/index.m3u8`);
      expect(missing.status).toBe(400);

      const invalid = await fetch(`${baseUrl}/api/dash/index.m3u8?d=not-base64!!`);
      expect(invalid.status).toBe(400);
    });

    test('returns 502 when the upstream MPD is unreachable', async () => {
      const d = Buffer.from(JSON.stringify({ mpdUrl: 'https://dead.example.com/x.mpd', key: KEY_HEX, kid: KID_HEX })).toString('base64url');
      const res = await fetch(`${baseUrl}/api/dash/index.m3u8?d=${d}`);
      expect(res.status).toBe(502);
    });
  });
});
