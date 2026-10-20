'use strict';

const fs = require('fs');
const path = require('path');
const DynamicCustomProvider = require('./DynamicCustomProvider');

class DynamicParserRegistry {
  constructor(opts = {}) {
    this.storagePath = opts.storagePath || path.join(__dirname, '..', '..', 'data', 'custom_parsers.json');
    this.activeProviders = new Map(); // sourceName -> DynamicCustomProvider instance
  }

  _ensureStorage() {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.storagePath)) {
      fs.writeFileSync(this.storagePath, JSON.stringify([], null, 2), 'utf8');
    }
  }

  loadConfigs() {
    this._ensureStorage();
    try {
      const data = fs.readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('[DynamicParserRegistry] Failed to read storage file:', err.message);
      return [];
    }
  }

  saveConfigs(configs) {
    this._ensureStorage();
    fs.writeFileSync(this.storagePath, JSON.stringify(configs, null, 2), 'utf8');
  }

  /**
   * Initializes all saved dynamic parsers into runtime.
   */
  init(container) {
    const configs = this.loadConfigs();
    console.log(`[DynamicParserRegistry] Loading ${configs.length} saved custom parser(s)...`);

    for (const config of configs) {
      try {
        this.mountProvider(config, container);
      } catch (err) {
        console.error(`[DynamicParserRegistry] Failed to mount parser ${config.name}:`, err.message);
      }
    }
  }

  /**
   * Mounts a single parser into runtime memory (MatchAggregator, catalog, streams).
   */
  mountProvider(config, container) {
    const circuitBreaker = container ? container.resolve('circuitBreaker') : null;
    const providerInstance = new DynamicCustomProvider(config, { circuitBreaker });
    const sourceName = providerInstance.sourceName;

    // 1. Add to local registry map
    this.activeProviders.set(sourceName, providerInstance);

    // 2. Add to REPLAY_SOURCES Set in catalog.js
    try {
      const { REPLAY_SOURCES } = require('../catalog');
      if (REPLAY_SOURCES && typeof REPLAY_SOURCES.add === 'function') {
        REPLAY_SOURCES.add(sourceName);
      }
    } catch (_) {}

    // 3. Add to KNOWN_REPLAY_SOURCES in streams.js
    try {
      const { KNOWN_REPLAY_SOURCES } = require('../streams');
      if (Array.isArray(KNOWN_REPLAY_SOURCES) && !KNOWN_REPLAY_SOURCES.includes(sourceName)) {
        KNOWN_REPLAY_SOURCES.push(sourceName);
      }
    } catch (_) {}

    // 4. Inject into MatchAggregator
    if (container) {
      try {
        const aggregator = container.resolve('matchAggregator');
        if (aggregator && Array.isArray(aggregator.providers)) {
          // Replace existing or add new
          const existingIdx = aggregator.providers.findIndex(p => p.sourceName === sourceName);
          if (existingIdx >= 0) {
            aggregator.providers[existingIdx] = providerInstance;
          } else {
            aggregator.providers.push(providerInstance);
          }
          console.log(`[DynamicParserRegistry] Registered '${providerInstance.name}' (${sourceName}) into live MatchAggregator`);
        }
      } catch (err) {
        console.warn(`[DynamicParserRegistry] Could not resolve MatchAggregator: ${err.message}`);
      }
    }

    return providerInstance;
  }

  /**
   * Unmounts a parser from runtime memory.
   */
  unmountProvider(sourceName, container) {
    this.activeProviders.delete(sourceName);

    try {
      const { REPLAY_SOURCES } = require('../catalog');
      if (REPLAY_SOURCES && typeof REPLAY_SOURCES.delete === 'function') {
        REPLAY_SOURCES.delete(sourceName);
      }
    } catch (_) {}

    try {
      const { KNOWN_REPLAY_SOURCES } = require('../streams');
      if (Array.isArray(KNOWN_REPLAY_SOURCES)) {
        const idx = KNOWN_REPLAY_SOURCES.indexOf(sourceName);
        if (idx >= 0) KNOWN_REPLAY_SOURCES.splice(idx, 1);
      }
    } catch (_) {}

    if (container) {
      try {
        const aggregator = container.resolve('matchAggregator');
        if (aggregator && Array.isArray(aggregator.providers)) {
          aggregator.providers = aggregator.providers.filter(p => p.sourceName !== sourceName);
        }
      } catch (_) {}
    }
  }

  /**
   * Adds or updates a custom parser and activates it in runtime.
   */
  saveParser(config, container) {
    if (!config || !config.name || !config.baseUrl || !config.selectors) {
      throw new Error('Parser configuration must include name, baseUrl, and selectors');
    }

    const cleanName = config.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const entry = {
      id: cleanName,
      name: cleanName,
      displayName: config.displayName || config.name,
      baseUrl: config.baseUrl,
      category: config.category || 'other',
      selectors: config.selectors,
      videoExtractor: config.videoExtractor || 'auto',
      createdAt: config.createdAt || Date.now()
    };

    const configs = this.loadConfigs();
    const existingIdx = configs.findIndex(c => c.name === cleanName);
    if (existingIdx >= 0) {
      configs[existingIdx] = entry;
    } else {
      configs.push(entry);
    }

    this.saveConfigs(configs);
    const providerInstance = this.mountProvider(entry, container);

    return {
      success: true,
      provider: providerInstance
    };
  }

  /**
   * Deletes a custom parser by name or id.
   */
  deleteParser(nameOrId, container) {
    const cleanName = (nameOrId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const configs = this.loadConfigs();
    const filtered = configs.filter(c => c.name !== cleanName && c.id !== cleanName);

    if (filtered.length === configs.length) {
      return { success: false, error: 'Parser not found' };
    }

    this.saveConfigs(filtered);
    this.unmountProvider(cleanName, container);

    return { success: true, removed: cleanName };
  }

  /**
   * Returns list of all configured dynamic parsers.
   */
  listParsers() {
    return this.loadConfigs();
  }
}

// Global Singleton
const dynamicParserRegistry = new DynamicParserRegistry();

module.exports = dynamicParserRegistry;
module.exports.DynamicParserRegistry = DynamicParserRegistry;
