#!/usr/bin/env node
'use strict';

/**
 * scripts/benchmark_streamedpk_comparison.js
 *
 * Side-by-side benchmark comparing Streamed.pk resolution time:
 * - Current VPS Production (old engine): https://nuviosports.xyz
 * - New Worker Pool Engine (this branch): http://localhost:7000 (or in-process resolver)
 *
 * Guaranteed ZERO modification to the VPS.
 */

const VPS_URL = process.env.VPS_URL || 'https://nuviosports.xyz';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:7000';

async function fetchJson(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const json = await res.json();
    const elapsed = Math.round(performance.now() - start);
    clearTimeout(timer);
    return { ok: true, status: res.status, elapsed, data: json };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, elapsed: Math.round(performance.now() - start), error: err.message };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('⚡ STREAMED.PK PERFORMANCE BENCHMARK (VPS vs NEW ENGINE)');
  console.log(`• Live VPS (Untouched): ${VPS_URL}`);
  console.log(`• Local New Engine:     ${LOCAL_URL}`);
  console.log('='.repeat(70));

  console.log('\n[1/3] Fetching live Streamed.pk fixtures from VPS catalog...');
  const catalogRes = await fetchJson(`${VPS_URL}/catalog/tv/nuvio_sports_live.json`, 15000);
  if (!catalogRes.ok || !catalogRes.data?.metas) {
    console.error('Failed to fetch catalog from VPS:', catalogRes.error);
    process.exit(1);
  }

  const spkMatches = catalogRes.data.metas.filter(m => m.id.startsWith('nuvio_sport_spk_'));
  console.log(`Found ${spkMatches.length} active Streamed.pk matches.\n`);

  if (spkMatches.length === 0) {
    console.log('No active SPK matches online right now.');
    process.exit(0);
  }

  // Pick top 3-4 matches to benchmark
  const testMatches = spkMatches.slice(0, 4);

  console.log('[2/3] Benchmarking stream resolution latency...\n');
  console.log(
    'Match Name'.padEnd(35) +
    'VPS Latency'.padEnd(16) +
    'Local Latency'.padEnd(16) +
    'Speedup'.padEnd(12) +
    'Streams'
  );
  console.log('-'.repeat(90));

  for (const match of testMatches) {
    const matchName = (match.name || match.id).replace(/[🔴📺 LIVE:\s]+/g, ' ').trim().slice(0, 32);

    // 1. Hit VPS
    const vpsStart = performance.now();
    const vpsResult = await fetchJson(`${VPS_URL}/stream/tv/${match.id}.json`, 30000);
    const vpsTime = vpsResult.ok ? `${vpsResult.elapsed} ms` : (vpsResult.error || 'ERR');
    const vpsStreams = vpsResult.data?.streams?.length || 0;

    // 2. Hit Local
    const localResult = await fetchJson(`${LOCAL_URL}/stream/tv/${match.id}.json`, 30000);
    const localTime = localResult.ok ? `${localResult.elapsed} ms` : (localResult.error || 'OFFLINE');
    const localStreams = localResult.data?.streams?.length || 0;

    let speedup = 'N/A';
    if (vpsResult.ok && localResult.ok && localResult.elapsed > 0) {
      const ratio = (vpsResult.elapsed / localResult.elapsed).toFixed(1);
      speedup = `${ratio}x faster`;
    }

    console.log(
      matchName.padEnd(35) +
      vpsTime.padEnd(16) +
      localTime.padEnd(16) +
      speedup.padEnd(12) +
      `VPS: ${vpsStreams} | Loc: ${localStreams}`
    );
  }

  console.log('\n[3/3] Benchmark Complete.');
  console.log('Note: VPS was queried purely as a client over HTTPS. Zero code or files touched on VPS.');
}

main().catch(console.error);
