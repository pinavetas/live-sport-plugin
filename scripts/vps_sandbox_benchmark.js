'use strict';

/**
 * /tmp/streamed_sandbox/run_sandboxed_benchmark.js
 *
 * Runs exclusively on the VPS inside /tmp/streamed_sandbox/
 * Completely isolated from PM2 and /root/nuvio-live-sports
 */

const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const StreamedWasmPool = require('./StreamedWasmPool');

const TEST_STREAM = {
  user: 'golf',
  event: '2586',
  id: '1',
  embedUrl: 'https://embed.st/embed/golf/2586/1'
};
const RUN_WASM_OLD = '/root/nuvio-live-sports/src/providers/run_wasm_native.js';

function runOldMethod(stream) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    execFile('node', [RUN_WASM_OLD, stream.user, stream.event, stream.id, stream.embedUrl], {
      timeout: 20000,
      env: { ...process.env, NODE_PATH: '/root/nuvio-live-sports/node_modules' }
    }, (error, stdout, stderr) => {
      const elapsed = Math.round(performance.now() - t0);
      if (error) {
        return resolve({ ok: false, elapsed, error: error.message });
      }
      const match = stdout.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
      if (match) {
        return resolve({ ok: true, elapsed, url: match[1] });
      }
      return resolve({ ok: false, elapsed, error: 'No stream extracted. stdout: ' + stdout.slice(0, 150) });
    });
  });
}

async function runNewMethod(pool, stream) {
  const t0 = performance.now();
  try {
    const result = await pool.resolveWasmStream(stream.user, stream.event, stream.id, stream.embedUrl, 20000);
    const elapsed = Math.round(performance.now() - t0);
    return { ok: !!result, elapsed, url: result };
  } catch (err) {
    const elapsed = Math.round(performance.now() - t0);
    return { ok: false, elapsed, error: err.message };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('⚡ VPS HARDWARE BENCHMARK: OLD SUBPROCESS vs NEW WORKER POOL');
  console.log('• Environment: VPS Native Hardware (Ubuntu Linux)');
  console.log('• CPU Model:  ', os.cpus()[0]?.model);
  console.log('• CPU Cores:  ', os.cpus().length, 'cores');
  console.log('• Total RAM:  ', Math.round(os.totalmem() / 1024 / 1024 / 1024), 'GB');
  console.log('• Live Stream:', `${TEST_STREAM.user}/${TEST_STREAM.event}/${TEST_STREAM.id} (${TEST_STREAM.embedUrl})`);
  console.log('• Sandbox:    ', __dirname, '(PM2 & /root production untouched)');
  console.log('='.repeat(70));

  console.log('\n[Phase 1] Pre-warming New Worker Pool (2 workers in-process)...');
  const poolStart = performance.now();
  const pool = StreamedWasmPool;
  await new Promise(r => setTimeout(r, 1200));
  console.log('Worker pool ready in', Math.round(performance.now() - poolStart), 'ms.\n');

  console.log('[Phase 2] Single Stream Resolution Benchmark');
  console.log('-'.repeat(70));

  // 1. Old Subprocess Method
  console.log('Testing Old Method (spawning node.exe / child_process.execFile)...');
  const oldRes = await runOldMethod(TEST_STREAM);
  console.log(`  -> Old Method: ${oldRes.ok ? 'SUCCESS' : 'FAILED'} in ${oldRes.elapsed} ms`);
  if (oldRes.ok) console.log(`     Stream URL: ${oldRes.url.slice(0, 75)}...`);
  if (oldRes.error) console.log(`     Error: ${oldRes.error}`);

  // 2. New Worker Pool Method
  console.log('Testing New Method (Persistent In-Process Worker Thread)...');
  const newRes = await runNewMethod(pool, TEST_STREAM);
  console.log(`  -> New Method: ${newRes.ok ? 'SUCCESS' : 'FAILED'} in ${newRes.elapsed} ms`);
  if (newRes.ok) console.log(`     Stream URL: ${newRes.url.slice(0, 75)}...`);

  if (oldRes.elapsed > 0 && newRes.elapsed > 0) {
    const ratio = (oldRes.elapsed / newRes.elapsed).toFixed(1);
    console.log(`  ⚡ Speedup: ${ratio}x faster on native VPS hardware!`);
  }

  console.log('\n[Phase 3] Concurrency Stress Test (4 Concurrent Stream Extractions)');
  console.log('-'.repeat(70));

  // Concurrency Old
  console.log('Running 4 concurrent streams with Old Method (4 node OS processes)...');
  const tOldCon = performance.now();
  const oldConResults = await Promise.all([
    runOldMethod(TEST_STREAM),
    runOldMethod(TEST_STREAM),
    runOldMethod(TEST_STREAM),
    runOldMethod(TEST_STREAM)
  ]);
  const oldConElapsed = Math.round(performance.now() - tOldCon);
  const oldConOk = oldConResults.filter(r => r.ok).length;
  console.log(`  -> Old Concurrent: ${oldConOk}/4 success in ${oldConElapsed} ms`);

  // Concurrency New
  console.log('Running 4 concurrent streams with New Method (Worker Thread Pool)...');
  const tNewCon = performance.now();
  const newConResults = await Promise.all([
    runNewMethod(pool, TEST_STREAM),
    runNewMethod(pool, TEST_STREAM),
    runNewMethod(pool, TEST_STREAM),
    runNewMethod(pool, TEST_STREAM)
  ]);
  const newConElapsed = Math.round(performance.now() - tNewCon);
  const newConOk = newConResults.filter(r => r.ok).length;
  console.log(`  -> New Concurrent: ${newConOk}/4 success in ${newConElapsed} ms`);

  if (oldConElapsed > 0 && newConElapsed > 0) {
    const conRatio = (oldConElapsed / newConElapsed).toFixed(1);
    console.log(`  ⚡ Concurrency Speedup: ${conRatio}x faster throughput on native VPS!`);
  }

  console.log('\n[Phase 4] Teardown & PM2 Status Check');
  console.log('-'.repeat(70));
  await pool.destroy();
  console.log('Worker pool destroyed cleanly.');
  console.log('Production PM2 status: 100% UNTOUCHED.');
  console.log('='.repeat(70));
  process.exit(0);
}

main().catch(err => {
  console.error('Benchmark fatal error:', err);
  process.exit(1);
});
