'use strict';

/**
 * run_puppeteer_extractor.js
 *
 * Generic headless browser network sniffer for live streams.
 * Intercepts HLS (.m3u8) and DASH (.mpd) manifests from complex or obfuscated embed players.
 *
 * Features:
 * - Dynamic loader: puppeteer-extra (with stealth), standard puppeteer, or puppeteer-core
 * - Resource blocking: aborts images, fonts, media, and ad trackers for fast load times
 * - Active player triggers: unmutes and clicks play buttons / video elements
 * - Structured JSON output on stdout: { success: true, file, type, headers }
 * - Strict timeout protection preventing hanging processes
 */

function resolvePuppeteer() {
  try {
    const extra = require('puppeteer-extra');
    try {
      const Stealth = require('puppeteer-extra-plugin-stealth');
      extra.use(Stealth());
    } catch (_) {}
    return extra;
  } catch (_) {
    try {
      return require('puppeteer');
    } catch (_) {
      try {
        return require('puppeteer-core');
      } catch (_) {
        return null;
      }
    }
  }
}

const args = process.argv.slice(2);
const targetUrl = args[0];
const referer = args[1] && args[1] !== 'EMPTY' ? args[1] : null;
const timeoutMs = Math.max(5000, Math.min(30000, Number(args[2]) || 15000));

if (!targetUrl) {
  console.error(JSON.stringify({ success: false, error: 'No target URL provided' }));
  process.exit(1);
}

const puppeteer = resolvePuppeteer();

if (!puppeteer) {
  console.error(JSON.stringify({ success: false, error: 'No puppeteer package available' }));
  process.exit(2);
}

(async () => {
  let browser = null;
  let foundStream = null;

  const timer = setTimeout(async () => {
    if (!foundStream) {
      console.error(JSON.stringify({ success: false, error: 'Timeout waiting for stream manifest' }));
      if (browser) {
        try { await browser.close(); } catch (_) {}
      }
      process.exit(1);
    }
  }, timeoutMs);

  try {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--mute-audio'
    ];

    const launchOpts = {
      headless: 'new',
      args: launchArgs
    };

    const customExec = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
    if (customExec) {
      launchOpts.executablePath = customExec;
    }

    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
    await page.setUserAgent(userAgent);

    if (referer) {
      await page.setExtraHTTPHeaders({
        'Referer': referer
      });
    }

    await page.setRequestInterception(true);

    page.on('request', req => {
      const resourceType = req.resourceType();
      const url = req.url();

      // Block non-essential media, fonts, images and ads for blazingly fast load
      if (['image', 'font', 'media'].includes(resourceType) && !url.includes('.m3u8') && !url.includes('.mpd')) {
        return req.abort();
      }

      if (/analytics|doubleclick|googletagmanager|adservice|popcash|popads|propellerads/i.test(url)) {
        return req.abort();
      }

      req.continue();
    });

    const checkStreamHit = async (candidateUrl, contentType = '') => {
      if (foundStream || !candidateUrl) return;

      let url = candidateUrl;
      if (url.includes('url=') || url.includes('source=') || url.includes('file=')) {
        try {
          const match = url.match(/(?:url|source|file)=([^&]+)/);
          if (match) {
            const decoded = decodeURIComponent(match[1]);
            if (decoded.includes('.m3u8') || decoded.includes('.mpd')) {
              url = decoded;
            }
          }
        } catch (_) {}
      }

      const isHls = url.includes('.m3u8') || contentType.includes('mpegurl');
      const isDash = url.includes('.mpd') || contentType.includes('dash+xml');

      if ((isHls || isDash) && !url.includes('blank.m3u8') && !url.includes('empty.m3u8')) {
        foundStream = {
          success: true,
          file: url,
          type: isDash ? 'dash' : 'hls',
          headers: {
            'User-Agent': userAgent,
            'Referer': referer || targetUrl,
            'Origin': new URL(targetUrl).origin
          }
        };

        clearTimeout(timer);
        console.log(JSON.stringify(foundStream));

        try { await browser.close(); } catch (_) {}
        process.exit(0);
      }
    };

    page.on('response', async res => {
      const url = res.url();
      const contentType = (res.headers()['content-type'] || '').toLowerCase();
      await checkStreamHit(url, contentType);
    });

    page.on('request', async req => {
      const url = req.url();
      await checkStreamHit(url);
    });

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(3000, timeoutMs - 2000)
    });

    // Active DOM triggering loop
    const pollIntervalMs = 1500;
    const maxPolls = Math.floor((timeoutMs - 4000) / pollIntervalMs);

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      if (foundStream) break;

      await page.evaluate(() => {
        try {
          const video = document.querySelector('video');
          if (video) {
            video.muted = true;
            video.play().catch(() => {});
          }
        } catch (_) {}

        try {
          document.querySelectorAll('.jw-video, .jw-media, video, .vjs-big-play-button, .vjs-tech, .jw-display-icon-display, button[aria-label*="Play" i], .play-button').forEach(el => {
            try { el.click(); } catch (_) {}
          });
        } catch (_) {}
      });

      const iframeStream = await page.evaluate(() => {
        let found = null;
        document.querySelectorAll('iframe').forEach(f => {
          try {
            const src = f.src || '';
            const match = src.match(/(?:url|source|file)=([^&]+)/);
            if (match) {
              const decoded = decodeURIComponent(match[1]);
              if (decoded.includes('.m3u8') || decoded.includes('.mpd')) found = decoded;
            }
          } catch (_) {}
        });
        return found;
      });

      if (iframeStream && !foundStream) {
        await checkStreamHit(iframeStream);
        break;
      }
    }

    if (!foundStream) {
      clearTimeout(timer);
      console.error(JSON.stringify({ success: false, error: 'Could not find m3u8 or mpd manifest in network traffic or DOM' }));
      if (browser) {
        try { await browser.close(); } catch (_) {}
      }
      process.exit(1);
    }
  } catch (err) {
    clearTimeout(timer);
    console.error(JSON.stringify({ success: false, error: err.message }));
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    process.exit(1);
  }
})();
