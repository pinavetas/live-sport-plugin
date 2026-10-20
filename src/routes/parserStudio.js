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

    // Trigger an immediate background fetch for this single provider so matches populate the cache
    if (result && result.provider && typeof result.provider.getMatches === 'function') {
      result.provider.getMatches().then(matches => {
        if (container && matches && matches.length > 0) {
          try {
            const cache = container.resolve('cacheService');
            const existing = cache ? cache.getMatches() : [];
            const merged = [...existing, ...matches];
            if (cache) cache.setMatches(merged);
            console.log(`[ParserStudio] Instantly populated cache with ${matches.length} matches from '${result.provider.name}'`);
          } catch (_) {}
        }
      }).catch(err => {
        console.warn(`[ParserStudio] Initial background crawl failed: ${err.message}`);
      });
    }

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
 * Triggers an immediate crawl of custom parsers and pushes matches to cache.
 */
router.post(['/sync', '/:name/sync'], async (req, res) => {
  const { name } = req.params;
  const container = req.app.get('container');
  const cache = container ? container.resolve('cacheService') : null;
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

  let totalExtracted = 0;
  for (const provider of targets) {
    try {
      const matches = await provider.getMatches();
      if (matches && matches.length > 0 && cache) {
        const existing = cache.getMatches() || [];
        const matchIds = new Set(matches.map(m => m.id));
        const filtered = existing.filter(m => !matchIds.has(m.id));
        cache.setMatches([...filtered, ...matches]);
        totalExtracted += matches.length;
      }
    } catch (err) {
      console.warn(`[ParserStudio] Sync failed for ${provider.name}: ${err.message}`);
    }
  }

  return res.json({
    success: true,
    message: `Synced ${targets.length} parser(s), extracted ${totalExtracted} matches`,
    extracted: totalExtracted
  });
});

module.exports = router;
