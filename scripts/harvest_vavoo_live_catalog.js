'use strict';

/**
 * Multi-Country Vavoo Live Catalog Harvester
 *
 * Automatically queries https://vavoo.to/mediahubmx-catalog.json across all
 * recognized regional groups using the live dual-ping auth ring (vypn.net / lokke.app).
 * Paginates through all cursor pages, deduplicates mirror feeds, classifies 4K streams,
 * and writes the fresh active dataset to src/data/vavoo_channels.json.
 */

const fs = require('fs');
const path = require('path');
const { VavooTokenManager } = require('../src/providers/VavooProvider');

const GROUPS = [
  { group: 'United Kingdom', lang: 'en', region: 'GB' },
  { group: 'Spain',          lang: 'es', region: 'ES' },
  { group: 'France',         lang: 'fr', region: 'FR' },
  { group: 'Germany',        lang: 'de', region: 'DE' },
  { group: 'Portugal',       lang: 'pt', region: 'PT' },
  { group: 'Italy',          lang: 'it', region: 'IT' },
  { group: 'Balkans',        lang: 'sr', region: 'RS' },
  { group: 'Croatia',        lang: 'hr', region: 'HR' },
  { group: 'Poland',         lang: 'pl', region: 'PL' },
  { group: 'Netherlands',    lang: 'nl', region: 'NL' },
  { group: 'Turkey',         lang: 'tr', region: 'TR' },
  { group: 'Arabia',         lang: 'ar', region: 'SA' },
  { group: 'Albania',        lang: 'sq', region: 'AL' },
  { group: 'Romania',        lang: 'ro', region: 'RO' },
  { group: 'Bulgaria',       lang: 'bg', region: 'BG' }
];

function cleanChannelName(rawName) {
  if (!rawName) return '';
  return rawName
    .replace(/\s*\.[a-z]\s*$/i, '')
    .replace(/\s*\(backup\)\s*/i, ' ')
    .replace(/\s*\[sat\]\s*/i, ' ')
    .replace(/\s*\[raw\]\s*/i, ' ')
    .replace(/\s*\[live during events only\]\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeChannelSlug(name, group) {
  return `${name}-${group}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchGroupPages(tokenManager, groupConfig) {
  const { group, lang, region } = groupConfig;
  const items = [];
  let cursor = 0;
  let page = 0;

  console.log(`\n📡 Harvesting [${group}] (region: ${region})...`);

  while (true) {
    page++;
    const sig = await tokenManager.getOrRefreshSig();
    const res = await fetch('https://vavoo.to/mediahubmx-catalog.json', {
      method: 'POST',
      headers: {
        'user-agent': 'okhttp/4.12.0',
        'accept': 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'mediahubmx-signature': sig
      },
      body: JSON.stringify({
        language: lang,
        region,
        catalogId: 'iptv',
        id: 'iptv',
        adult: false,
        search: '',
        sort: 'name',
        filter: { group },
        cursor,
        clientVersion: '3.0.2'
      })
    });

    if (!res.ok) {
      console.warn(`   ⚠️ Page ${page} failed with HTTP ${res.status}`);
      break;
    }

    const data = await res.json().catch(() => null);
    const pageItems = data?.items || [];
    if (pageItems.length === 0) break;

    items.push(...pageItems);
    process.stdout.write(`   Page ${page}: +${pageItems.length} (total: ${items.length})\r`);

    cursor = data.nextCursor;
    if (!cursor) break;

    // Small delay to be polite
    await new Promise(r => setTimeout(r, 60));
  }

  console.log(`\n   ✅ Harvested ${items.length} raw channels for ${group}`);
  return items;
}

async function harvestAll() {
  const startTime = Date.now();
  console.log('=== MULTI-COUNTRY VAVOO LIVE CATALOG HARVESTER ===');
  const tokenManager = new VavooTokenManager();

  const allRawItems = [];
  for (const grp of GROUPS) {
    try {
      const raw = await fetchGroupPages(tokenManager, grp);
      allRawItems.push(...raw);
    } catch (err) {
      console.error(`   ❌ Failed harvesting ${grp.group}:`, err.message);
    }
  }

  console.log(`\n📦 Total raw channels collected across all regions: ${allRawItems.length}`);

  // Deduplicate and structure
  const channelMap = new Map();

  for (const item of allRawItems) {
    if (!item || !item.url || !item.name) continue;

    // Filter out ephemeral event-only pop-up feeds while preserving continuous 24/7 channels on Server S
    if (/live during events only/i.test(item.name) || /\(event only\)/i.test(item.name)) {
      continue;
    }

    const group = item.group || 'Live TV';
    const cleanBaseName = cleanChannelName(item.name);
    if (!cleanBaseName) continue;

    // Preserve multi-cluster mirrors (.b, .c, .s, HEVC, RAW, Backup) as separate entries
    let clusterSuffix = 'main';
    const isB = /\.b\b|server\s*b/i.test(item.name);
    const isC = /\.c\b|server\s*c/i.test(item.name);
    const isS = !isC && !isB && (/\.s\b|server\s*s/i.test(item.name));
    const isBkp = /\b(?:backup(?:\s*\d+)?)\b/i.test(item.name);
    const isHvc = /\bhevc\b|\bh265\b/i.test(item.name);
    const isRw = /\braw\b/i.test(item.name);

    if (isBkp) {
      clusterSuffix = isC ? 'c-backup' : (isS ? 's-backup' : (isB ? 'b-backup' : 'backup'));
    } else if (isHvc) {
      clusterSuffix = isC ? 'c-hevc' : (isS ? 's-hevc' : (isB ? 'b-hevc' : 'hevc'));
    } else if (isRw) {
      clusterSuffix = isC ? 'c-raw' : (isS ? 's-raw' : (isB ? 'b-raw' : 'raw'));
    } else if (isC) {
      clusterSuffix = 'c';
    } else if (isS) {
      clusterSuffix = 's';
    } else if (isB) {
      clusterSuffix = 'b';
    }

    const baseSlug = makeChannelSlug(cleanBaseName, group);
    const slug = `${baseSlug}-${clusterSuffix}`;
    const is4K = /4k|uhd/i.test(item.name) || /4k|uhd/i.test(group);
    const groupDef = GROUPS.find(g => g.group.toLowerCase() === group.toLowerCase());
    const language = groupDef ? groupDef.lang : 'en';

    if (!channelMap.has(slug)) {
      channelMap.set(slug, {
        id: slug,
        name: item.name.replace(/\s*\[live during events only\]\s*/i, '').trim(),
        group,
        language,
        is4k: is4K,
        vavooUrl: item.url,
        logo: item.logo || undefined
      });
    } else {
      const existing = channelMap.get(slug);
      if (item.logo && !existing.logo) existing.logo = item.logo;
    }
  }

  const finalCatalog = Array.from(channelMap.values()).sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.name.localeCompare(b.name);
  });

  console.log(`\n🎯 Cleaned, deduplicated unique channels: ${finalCatalog.length}`);

  // Breakdown by group
  const breakdown = {};
  for (const ch of finalCatalog) {
    breakdown[ch.group] = (breakdown[ch.group] || 0) + 1;
  }
  console.table(breakdown);

  // Write to src/data/vavoo_channels.json
  const outputPath = path.resolve(__dirname, '../src/data/vavoo_channels.json');
  fs.writeFileSync(outputPath, JSON.stringify(finalCatalog, null, 2), 'utf8');
  console.log(`💾 Saved updated catalog to ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

  // Also write public copy for direct inspection
  const publicPath = path.resolve(__dirname, '../public/vavoo_catalog.json');
  fs.writeFileSync(publicPath, JSON.stringify(finalCatalog, null, 2), 'utf8');
  console.log(`💾 Saved public copy to ${publicPath}`);

  console.log(`\n✨ Harvest completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s.`);
}

if (require.main === module) {
  harvestAll().catch(err => {
    console.error('Fatal harvest error:', err);
    process.exit(1);
  });
}

module.exports = { harvestAll, cleanChannelName, makeChannelSlug };
