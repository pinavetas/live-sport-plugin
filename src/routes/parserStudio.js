/**
 * parserStudio.js - REST API endpoints for AI-driven replay parser generation and management.
 */

'use strict';

const express = require('express');
const router = express.Router();
const AiParserGeneratorService = require('../services/AiParserGeneratorService');
const dynamicParserRegistry = require('../services/DynamicParserRegistry');
const { safeFetch } = require('../impitClient');

router.use(express.json());

const aiGenerator = new AiParserGeneratorService();

// Upper bound for how long POST /sync waits for the aggregator sync before
// answering; the sync keeps running in the background past it.
const SYNC_WAIT_MS = Number(process.env.PARSER_SYNC_WAIT_MS) || 45000;

/**
 * Triggers the regular aggregator sync, which crawls the mounted dynamic
 * parsers together with every other provider and merges/dedupes their
 * matches. Hand-merging a parser's raw matches into the cache bypassed that
 * normalization and appended duplicates on every re-save.
 * Returns the sync promise (errors are logged), or null when unavailable.
 */
function triggerAggregatorSync(container) {
  let cronService = null;
  try { cronService = container && container.resolve ? container.resolve('cronService') : null; } catch (_) {}
  if (!cronService || typeof cronService.requestSync !== 'function') return null;
  const run = Promise.resolve().then(() => cronService.requestSync());
  run.catch((err) => console.warn(`[ParserStudio] Aggregator sync failed: ${err.message}`));
  return run;
}

function countMatchesFromSources(container, sourceNames) {
  try {
    const cache = container.resolve('cacheService');
    const matches = (cache.getMatchesReadOnly ? cache.getMatchesReadOnly() : cache.getMatches()) || [];
    let count = 0;
    for (const m of matches) {
      if (m && Array.isArray(m.sources) && m.sources.some(s => s && sourceNames.has(s.source))) count++;
    }
    return count;
  } catch (_) {
    return 0;
  }
}

/**
 * POST /api/parser/generate
 * Analyzes target URL using AI (OpenCode / Freebuff / OpenAI compatible) and self-validates with Cheerio.
 */
router.post('/generate', async (req, res) => {
  const { url, aiConfig } = req.body || {};

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ success: false, error: 'A valid http(s) URL is required' });
  }

  try {
    const result = await aiGenerator.generateParser({ url, aiConfig });
    return res.json(result);
  } catch (err) {
    console.error('[ParserStudio] Generation failed:', err.message);
    return res.status(422).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/parser/test
 * Tests existing or manually modified selectors against a live URL.
 */
router.post('/test', async (req, res) => {
  const { url, selectors } = req.body || {};

  if (!url || !selectors) {
    return res.status(400).json({ success: false, error: 'URL and selectors are required' });
  }

  try {
    const pageRes = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
      },
      timeoutMs: 15000,
      attempts: 2
    });

    if (!pageRes.ok) {
      return res.status(502).json({ success: false, error: `Upstream HTTP ${pageRes.status}` });
    }

    const html = await pageRes.text();
    const result = aiGenerator.testSelectors(html, selectors, url);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/parser/save
 * Activates and persists a verified custom parser into live runtime.
 */
router.post('/save', async (req, res) => {
  const { config } = req.body || {};
  if (!config || !config.name || !config.baseUrl || !config.selectors) {
    return res.status(400).json({ success: false, error: 'Incomplete parser configuration' });
  }

  try {
    const container = req.app.get('container');
    const result = dynamicParserRegistry.saveParser(config, container);

    // The parser is now mounted in the aggregator; populate the catalog via a
    // background aggregator sync (respond immediately, don't wait for it).
    triggerAggregatorSync(container);

    return res.json({
      success: true,
      message: `Parser '${result.provider.name}' successfully activated and mounted in runtime`,
      sourceName: result.provider.sourceName
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/parser/list
 * Returns all saved custom parsers.
 */
router.get('/list', (req, res) => {
  const parsers = dynamicParserRegistry.listParsers();
  return res.json({ success: true, parsers });
});

/**
 * DELETE /api/parser/:name
 * Removes a custom parser from runtime and persistence.
 */
router.delete('/:name', (req, res) => {
  const { name } = req.params;
  const container = req.app.get('container');
  const result = dynamicParserRegistry.deleteParser(name, container);

  if (!result.success) {
    return res.status(404).json(result);
  }
  return res.json(result);
});

/**
 * POST /api/parser/sync or /api/parser/:name/sync
 * Triggers an aggregator sync (which crawls the custom parsers) and waits for
 * it up to SYNC_WAIT_MS. `extracted` is the number of catalog matches coming
 * from the targeted parser(s); `pending` is true when the sync was still
 * running at response time.
 */
router.post(['/sync', '/:name/sync'], async (req, res) => {
  const { name } = req.params;
  const container = req.app.get('container');
  const active = dynamicParserRegistry.activeProviders;

  const targets = [];
  if (name) {
    const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const p = active.get(cleanName);
    if (p) targets.push(p);
  } else {
    targets.push(...active.values());
  }

  if (targets.length === 0) {
    return res.status(404).json({ success: false, error: 'No matching active parser found' });
  }

  const syncRun = triggerAggregatorSync(container);
  if (!syncRun) {
    return res.status(503).json({ success: false, error: 'Match sync service unavailable' });
  }

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('pending'), SYNC_WAIT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  const outcome = await Promise.race([
    syncRun.then(() => 'done', (err) => ({ error: err })),
    timeout
  ]);
  clearTimeout(timer);

  if (outcome && outcome.error) {
    return res.status(502).json({ success: false, error: `Sync failed: ${outcome.error.message}` });
  }

  const pending = outcome === 'pending';
  const extracted = countMatchesFromSources(container, new Set(targets.map(p => p.sourceName)));
  return res.json({
    success: true,
    message: pending
      ? `Sync of ${targets.length} parser(s) still running in background; ${extracted} matches currently in catalog`
      : `Synced ${targets.length} parser(s), extracted ${extracted} matches`,
    extracted,
    pending
  });
});

module.exports = router;
