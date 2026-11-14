'use strict';

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalDecryptor } = require('../src/services/plooplayer/localDecryptor');
const { encodeDecryptorToken } = require('../src/services/plooplayer/PlooDecryptorToken');
const { bundleCommonJs } = require('../src/services/plooplayer/scriptBundler');
const { readBox } = require('../src/services/cenc/boxes');
const { KEY_HEX, KID_HEX, OTHER_KID, buildInit, buildSegment, sample, IV8 } = require('./fixtures/cenc-fixtures');

// Audio is keyed separately from video, as on the multi-key DAZN feeds.
const AUDIO_KEY_HEX = '00112233445566778899aabbccddeeff';
const MPD_URL = 'https://cdn.example.com/live/channel/manifest.mpd';

const MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <Representation id="v1" bandwidth="5000000" codecs="avc1.640028" width="1920" height="1080">
        <SegmentTemplate media="v1/seg-$Number$.m4s" initialization="v1/init.mp4" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="es">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate media="a1/seg-$Number$.m4s" initialization="a1/init.mp4" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

function audioSample(length, iv) {
  const plain = crypto.createHash('sha256').update(`audio:${length}`).digest();
  const body = Buffer.concat(Array.from({ length: Math.ceil(length / plain.length) }, () => plain)).subarray(0, length);
  const block = Buffer.alloc(16);
  iv.copy(block);
  const encrypted = crypto.createCipheriv('aes-128-ctr', Buffer.from(AUDIO_KEY_HEX, 'hex'), block).update(body);
  return { iv, subsamples: null, plain: body, encrypted };
}

const videoSample = sample(200, IV8(7), [{ clear: 5, cipher: 120 }, { clear: 3, cipher: 72 }]);
const aSample = audioSample(96, IV8(9));

const upstream = {
  [MPD_URL]: () => MPD,
  'https://cdn.example.com/live/channel/v1/init.mp4': () => buildInit({ kind: 'video', kid: KID_HEX, trackId: 1, tencLayout: 'shifted' }),
  'https://cdn.example.com/live/channel/a1/init.mp4': () => buildInit({ kind: 'audio', entryType: 'enca', kid: OTHER_KID, trackId: 2 }),
  'https://cdn.example.com/live/channel/v1/seg-3.m4s': () => buildSegment([{ trackId: 1, runs: [[videoSample]] }]),
  'https://cdn.example.com/live/channel/a1/seg-3.m4s': () => buildSegment([{ trackId: 2, runs: [[aSample]] }])
};

function mdatBody(buf) {
  for (let at = 0; at + 8 <= buf.length;) {
    const b = readBox(buf, at, buf.length);
    if (!b) break;
    if (b.type === 'mdat') return buf.subarray(b.body, b.end);
    at = b.end;
  }
  return null;
}

describe('Plooplayer local decryptor', () => {
  let server;
  let base;
  const seenHeaders = [];
  const fetchImpl = jest.fn(async (url, init) => {
    seenHeaders.push(init.headers);
    const make = upstream[url];
    if (!make) return new Response('nope', { status: 404 });
    return new Response(make(), { status: 200 });
  });
  const token = encodeDecryptorToken({
    mpdUrl: MPD_URL,
    keys: { [KID_HEX]: KEY_HEX, [OTHER_KID]: AUDIO_KEY_HEX },
    headers: { Referer: 'https://www.izzigo.tv/', 'User-Agent': 'TestUA/1.0' }
  });

  beforeAll(async () => {
    const { handle } = createLocalDecryptor({ fetchImpl, log: () => {} });
    server = http.createServer((req, res) => handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  test('master and media playlists point back at the decryptor', async () => {
    const master = await (await fetch(`${base}/ploo/index.m3u8?d=${token}`)).text();
    expect(master).toContain(`${base}/ploo/video.m3u8?d=${token}&r=v1`);
    expect(master).toMatch(/TYPE=AUDIO.*URI="http:\/\/127\.0\.0\.1:\d+\/ploo\/audio\.m3u8\?d=/);
    expect(seenHeaders[0]).toMatchObject({ Referer: 'https://www.izzigo.tv/', 'User-Agent': 'TestUA/1.0' });

    const video = await (await fetch(`${base}/ploo/video.m3u8?d=${token}&r=v1`)).text();
    expect(video).toContain(`#EXT-X-MAP:URI="${base}/ploo/init.mp4?d=${token}&k=video&r=v1"`);
    expect(video).toContain(`${base}/ploo/segment.mp4?d=${token}&k=video&r=v1&n=3`);
    expect(video).not.toContain('#EXT-X-KEY');
  });

  test('init segments come back without protection boxes', async () => {
    const res = await fetch(`${base}/ploo/init.mp4?d=${token}&k=video&r=v1`);
    expect(res.status).toBe(200);
    const init = Buffer.from(await res.arrayBuffer());
    expect(init.includes(Buffer.from('encv'))).toBe(false);
    expect(init.includes(Buffer.from('tenc'))).toBe(false);
    expect(init.includes(Buffer.from('avc1'))).toBe(true);
  });

  test('video and audio segments are decrypted with their own keys', async () => {
    const v = Buffer.from(await (await fetch(`${base}/ploo/segment.mp4?d=${token}&k=video&r=v1&n=3`)).arrayBuffer());
    expect(mdatBody(v).equals(videoSample.plain)).toBe(true);
    const a = Buffer.from(await (await fetch(`${base}/ploo/segment.mp4?d=${token}&k=audio&r=a1&n=3`)).arrayBuffer());
    expect(mdatBody(a).equals(aSample.plain)).toBe(true);
  });

  test('rejects missing or invalid tokens and unknown paths', async () => {
    expect((await fetch(`${base}/ploo/index.m3u8`)).status).toBe(400);
    expect((await fetch(`${base}/ploo/index.m3u8?d=garbage`)).status).toBe(403);
    expect((await fetch(`${base}/ploo/segment.mp4?d=${token}&k=video&r=v1&n=x`)).status).toBe(400);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, name: 'plooplayer-decryptor' });
  });

  test('upstream failures surface as 502, never as partial media', async () => {
    const res = await fetch(`${base}/ploo/segment.mp4?d=${token}&k=video&r=v1&n=4`);
    expect(res.status).toBe(502);
  });

  test('private upstream hosts are refused', async () => {
    const evil = encodeDecryptorToken({ mpdUrl: 'http://169.254.169.254/latest/meta-data.mpd' });
    expect((await fetch(`${base}/ploo/index.m3u8?d=${evil}`)).status).toBe(403);
  });
});

describe('cenc init with several expected KIDs', () => {
  const { parseInit } = require('../src/services/cenc/init');

  test('picks the tenc layout whose KID is one of the published ones', () => {
    const init = buildInit({ kind: 'video', kid: KID_HEX, tencLayout: 'shifted' });
    expect(parseInit(init, { expectedKid: [OTHER_KID, KID_HEX] }).tracks.get(1).kid).toBe(KID_HEX);
    // single-string form keeps working
    expect(parseInit(init, { expectedKid: KID_HEX }).tracks.get(1).kid).toBe(KID_HEX);
  });
});

describe('bundled decryptor script', () => {
  const srcRoot = path.join(__dirname, '..', 'src');
  const build = () => bundleCommonJs(path.join(srcRoot, 'services', 'plooplayer', 'localDecryptorCli.js'), {
    rootDir: srcRoot,
    stubs: [path.join(srcRoot, 'services', 'ProviderOutbound.js')],
    allowExternal: ['fast-xml-parser']
  });

  test('contains only node core dependencies', () => {
    const { modules, externals } = build();
    expect(modules).toEqual(expect.arrayContaining(['services/DashToHlsService.js', 'services/cenc/segment.js', 'services/plooplayer/miniXml.js']));
    expect(externals).toEqual(['fast-xml-parser']); // lazy, never loaded when a parser is injected
  });

  test('fails loudly if a heavy dependency sneaks into the graph', () => {
    expect(() => bundleCommonJs(path.join(srcRoot, 'services', 'plooplayer', 'localDecryptorCli.js'), { rootDir: srcRoot }))
      .toThrow(/requires package/);
  });

  test('runs standalone with plain node and answers /health', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploo-bundle-'));
    const file = path.join(dir, 'ploo-decryptor.js');
    fs.writeFileSync(file, build().code);
    const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH, PORT: '0' } });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      const port = await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 10000);
        child.stdout.on('data', (chunk) => {
          out += chunk;
          const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        });
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
      });
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health).toMatchObject({ ok: true, name: 'plooplayer-decryptor' });
    } finally {
      child.kill();
      await exited; // Windows keeps the file locked until the process is gone
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
