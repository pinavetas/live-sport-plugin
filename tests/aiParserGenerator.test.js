'use strict';

const path = require('path');
const fs = require('fs');
const AiParserGeneratorService = require('../src/services/AiParserGeneratorService');
const { DynamicParserRegistry } = require('../src/services/DynamicParserRegistry');
const DynamicCustomProvider = require('../src/services/DynamicCustomProvider');
const { REPLAY_SOURCES } = require('../src/catalog');
const { KNOWN_REPLAY_SOURCES } = require('../src/streams');

const SAMPLE_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Sports Replays Online</title>
  <style>.ad-banner { display: block; }</style>
  <script>console.log("analytics tracker");</script>
</head>
<body>
  <nav><a href="/">Home</a></nav>
  <div class="ad-banner">Spam Banner</div>
  <main class="content-area">
    <div class="matches-grid">
      <article class="post-item" id="post-1">
        <h2 class="post-title"><a href="/replays/lakers-vs-celtics-full-game">Lakers vs Celtics Full Game Replay</a></h2>
        <span class="post-date">October 20, 2026</span>
        <div class="post-thumb"><img src="https://cdn.example.com/lakers.jpg" alt="Poster" /></div>
      </article>
      <article class="post-item" id="post-2">
        <h2 class="post-title"><a href="/replays/warriors-vs-bulls-full-game">Warriors vs Bulls Full Game Replay</a></h2>
        <span class="post-date">October 19, 2026</span>
        <div class="post-thumb"><img src="https://cdn.example.com/warriors.jpg" alt="Poster" /></div>
      </article>
    </div>
  </main>
  <footer>Copyright 2026</footer>
</body>
</html>
`;

describe('AiParserGeneratorService & DynamicParserRegistry', () => {
  let aiService;
  let testStoragePath;
  let registry;

  beforeEach(() => {
    aiService = new AiParserGeneratorService({
      baseUrl: 'https://mock-llm.example.com/v1',
      apiKey: 'test-key-123',
      model: 'deepseek-chat'
    });

    testStoragePath = path.join(__dirname, 'temp_custom_parsers_test.json');
    if (fs.existsSync(testStoragePath)) fs.unlinkSync(testStoragePath);

    registry = new DynamicParserRegistry({ storagePath: testStoragePath });
  });

  afterEach(() => {
    if (fs.existsSync(testStoragePath)) fs.unlinkSync(testStoragePath);
  });

  describe('AiParserGeneratorService - HTML Pruning', () => {
    test('removes scripts, styles, navbars, ads, and footers while preserving articles', () => {
      const pruned = aiService.pruneHtml(SAMPLE_PAGE_HTML);
      expect(pruned).not.toContain('analytics tracker');
      expect(pruned).not.toContain('Spam Banner');
      expect(pruned).not.toContain('<nav>');
      expect(pruned).not.toContain('<footer>');
      expect(pruned).toContain('Lakers vs Celtics');
      expect(pruned).toContain('post-item');
    });

    test('handles empty or malformed inputs gracefully', () => {
      expect(aiService.pruneHtml('')).toBe('');
      expect(aiService.pruneHtml(null)).toBe('');
    });
  });

  describe('AiParserGeneratorService - JSON extraction from LLM response', () => {
    test('parses pure JSON string', () => {
      const parsed = aiService.parseJsonFromResponse('{"name": "test", "category": "football"}');
      expect(parsed.name).toBe('test');
      expect(parsed.category).toBe('football');
    });

    test('parses markdown-fenced ```json code blocks', () => {
      const markdown = '```json\n{\n  "name": "fenced",\n  "category": "basketball"\n}\n```';
      const parsed = aiService.parseJsonFromResponse(markdown);
      expect(parsed.name).toBe('fenced');
      expect(parsed.category).toBe('basketball');
    });
  });

  describe('AiParserGeneratorService - Selector Testing & Self-Validation', () => {
    test('successfully extracts items and normalizes relative links', () => {
      const selectors = {
        matches: 'article.post-item',
        title: 'h2.post-title a',
        link: 'h2.post-title a -> href',
        time: '.post-date',
        thumbnail: '.post-thumb img -> src'
      };

      const result = aiService.testSelectors(SAMPLE_PAGE_HTML, selectors, 'https://example.com');
      expect(result.valid).toBe(true);
      expect(result.count).toBe(2);
      expect(result.sample).toHaveLength(2);
      expect(result.sample[0].title).toBe('Lakers vs Celtics Full Game Replay');
      expect(result.sample[0].link).toBe('https://example.com/replays/lakers-vs-celtics-full-game');
      expect(result.sample[0].thumbnail).toBe('https://cdn.example.com/lakers.jpg');
      expect(result.sample[0].time).toBe('October 20, 2026');
    });

    test('fails gracefully when selectors do not match', () => {
      const badSelectors = {
        matches: '.non-existent-wrapper .card',
        title: '.title',
        link: 'a'
      };

      const result = aiService.testSelectors(SAMPLE_PAGE_HTML, badSelectors, 'https://example.com');
      expect(result.valid).toBe(false);
      expect(result.count).toBe(0);
      expect(result.error).toContain('matched 0 elements');
    });
  });

  describe('AiParserGeneratorService - Full Generation with Self-Correction', () => {
    test('triggers 1-shot self-correction loop when initial selectors fail', async () => {
      aiService.fetchFn = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => SAMPLE_PAGE_HTML
      });

      // 1st LLM call returns bad selectors; 2nd LLM call returns valid selectors
      const badAnswer = JSON.stringify({
        name: 'testreplays',
        displayName: 'Test Replays',
        category: 'basketball',
        selectors: { matches: '.wrong-card', title: 'h2', link: 'a' }
      });

      const goodAnswer = JSON.stringify({
        name: 'testreplays',
        displayName: 'Test Replays',
        category: 'basketball',
        selectors: {
          matches: 'article.post-item',
          title: 'h2.post-title a',
          link: 'h2.post-title a -> href'
        }
      });

      const querySpy = jest.spyOn(aiService, 'queryLlm')
        .mockResolvedValueOnce(badAnswer)
        .mockResolvedValueOnce(goodAnswer);

      const genResult = await aiService.generateParser({ url: 'https://example.com/replays' });

      expect(querySpy).toHaveBeenCalledTimes(2); // Initial attempt + 1 correction loop
      expect(genResult.success).toBe(true);
      expect(genResult.providerConfig.name).toBe('testreplays');
      expect(genResult.preview.totalFound).toBe(2);
      expect(genResult.preview.sample[0].title).toBe('Lakers vs Celtics Full Game Replay');

      jest.restoreAllMocks();
    });
  });

  describe('DynamicParserRegistry - Live Storage & Runtime Hot-Mounting', () => {
    test('saves, mounts, lists, and unmounts custom parsers dynamically', () => {
      const mockContainer = {
        resolve: jest.fn((name) => {
          if (name === 'circuitBreaker') return { wrapSync: () => ({ fire: jest.fn() }) };
          if (name === 'matchAggregator') return { providers: [] };
          return null;
        })
      };

      const config = {
        name: 'testnba',
        displayName: 'Test NBA',
        baseUrl: 'https://example.com/nba',
        category: 'basketball',
        selectors: {
          matches: 'article.post-item',
          title: 'h2.post-title a',
          link: 'h2.post-title a -> href'
        }
      };

      // 1. Save and mount
      const saved = registry.saveParser(config, mockContainer);
      expect(saved.success).toBe(true);
      expect(saved.provider).toBeInstanceOf(DynamicCustomProvider);
      expect(saved.provider.sourceName).toBe('testnba');

      // Check REPLAY_SOURCES and KNOWN_REPLAY_SOURCES dynamic additions
      expect(REPLAY_SOURCES.has('testnba')).toBe(true);
      expect(KNOWN_REPLAY_SOURCES).toContain('testnba');

      // 2. List
      const list = registry.listParsers();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('testnba');

      // 3. Delete
      const del = registry.deleteParser('testnba', mockContainer);
      expect(del.success).toBe(true);
      expect(registry.listParsers()).toHaveLength(0);
      expect(REPLAY_SOURCES.has('testnba')).toBe(false);
      expect(KNOWN_REPLAY_SOURCES).not.toContain('testnba');
    });
  });
});
