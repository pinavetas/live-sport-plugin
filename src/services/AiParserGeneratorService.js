/**
 * AiParserGeneratorService.js - Automated scraping parser generator using LLMs.
 *
 * Compatible with OpenCode, Freebuff, OpenAI, and any standard OpenAI-compatible API.
 * Takes a sports replay URL, prunes the DOM, queries the LLM for Cheerio CSS selectors,
 * and validates the selectors against the live webpage with an automated correction loop.
 */

'use strict';

const cheerio = require('cheerio');
const { safeFetch } = require('../impitClient');

class AiParserGeneratorService {
  constructor(opts = {}) {
    this.defaultBaseUrl = opts.baseUrl || process.env.AI_BASE_URL || process.env.OPENCODE_API_URL || 'https://api.openai.com/v1';
    this.defaultApiKey = opts.apiKey || process.env.AI_API_KEY || process.env.OPENCODE_API_KEY || '';
    this.defaultModel = opts.model || process.env.AI_MODEL || 'deepseek-chat';
    this.maxHtmlTokens = opts.maxHtmlTokens || 12000; // ~3000-4000 tokens
    this.fetchFn = opts.fetchFn || safeFetch;
  }

  /**
   * Prunes raw HTML down to a semantic structural skeleton to minimize token costs and eliminate ad noise.
   */
  pruneHtml(rawHtml) {
    if (!rawHtml || typeof rawHtml !== 'string') return '';
    const $ = cheerio.load(rawHtml);

    // Remove noise, scripts, ads, and layout boilerplate
    $('script, style, svg, iframe, noscript, nav, footer, header, form, input, button, select, [id*="cookie"], [class*="cookie"], [id*="banner"], [class*="ad-"]').remove();

    // Strip bulky attributes while preserving classes, IDs, hrefs, and images
    $('*').each((_, el) => {
      const attribs = el.attribs || {};
      for (const attr of Object.keys(attribs)) {
        if (!['class', 'id', 'href', 'src', 'title', 'alt', 'data-url'].includes(attr.toLowerCase())) {
          delete attribs[attr];
        }
      }
    });

    // Extract body contents
    let pruned = $('body').html() || $.html();
    // Collapse excessive whitespace
    pruned = pruned.replace(/\s+/g, ' ').replace(/> </g, '><').trim();

    // Slice to bounded token budget
    if (pruned.length > this.maxHtmlTokens) {
      pruned = pruned.slice(0, this.maxHtmlTokens);
    }

    return pruned;
  }

  /**
   * Dispatches request to an OpenAI-compatible /chat/completions endpoint.
   */
  async queryLlm({ prompt, systemPrompt, config = {} }) {
    const rawBaseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const endpoint = rawBaseUrl.endsWith('/chat/completions') 
      ? rawBaseUrl 
      : `${rawBaseUrl}/chat/completions`;

    const apiKey = config.apiKey !== undefined ? config.apiKey : this.defaultApiKey;
    const model = config.model || this.defaultModel;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Nuvio-AI-Parser-Studio/1.0'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const payload = {
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    };

    const res = await this.fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeoutMs: 35000,
      attempts: 1
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM API returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM returned an empty response');
    }

    return content;
  }

  /**
   * Cleans and parses LLM JSON output even if wrapped in markdown code blocks.
   */
  parseJsonFromResponse(content) {
    let clean = String(content).trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    }
    return JSON.parse(clean);
  }

  /**
   * Tests candidate selectors against the actual page HTML using Cheerio.
   */
  testSelectors(html, selectors, baseUrl = '') {
    if (!html || !selectors || !selectors.matches) {
      return { valid: false, count: 0, sample: [], error: 'Missing matches selector' };
    }

    try {
      const $ = cheerio.load(html);
      const matchElements = $(selectors.matches);
      const count = matchElements.length;

      if (count === 0) {
        return { valid: false, count: 0, sample: [], error: `Selector '${selectors.matches}' matched 0 elements` };
      }

      const sample = [];
      matchElements.slice(0, 10).each((i, el) => {
        // Title extraction
        let title = '';
        if (selectors.title) {
          title = $(el).find(selectors.title).first().text().trim();
          if (!title && $(el).is(selectors.title)) title = $(el).text().trim();
        }

        // Link extraction (supports "selector -> attr" or direct "selector")
        let link = '';
        if (selectors.link) {
          const parts = selectors.link.split('->').map(s => s.trim());
          const target = parts[0] ? $(el).find(parts[0]) : $(el);
          const attr = parts[1] || 'href';
          link = target.attr(attr) || '';
        }

        // Normalise relative links
        if (link && !link.startsWith('http') && baseUrl) {
          try {
            link = new URL(link, baseUrl).href;
          } catch (_) {}
        }

        // Optional time
        let time = '';
        if (selectors.time) {
          time = $(el).find(selectors.time).first().text().trim();
        }

        // Optional thumbnail
        let thumbnail = '';
        if (selectors.thumbnail) {
          const parts = selectors.thumbnail.split('->').map(s => s.trim());
          const target = parts[0] ? $(el).find(parts[0]) : $(el).find('img');
          const attr = parts[1] || 'src';
          thumbnail = target.attr(attr) || target.attr('data-src') || '';
        }

        if (title && link) {
          sample.push({ id: `preview_${i}`, title, link, time, thumbnail });
        }
      });

      const valid = sample.length > 0;
      return {
        valid,
        count,
        sample,
        error: valid ? null : 'Extracted items contained empty titles or links'
      };
    } catch (err) {
      return { valid: false, count: 0, sample: [], error: err.message };
    }
  }

  /**
   * End-to-end generator: fetches URL, analyzes with LLM, and self-validates with Cheerio.
   */
  async generateParser({ url, aiConfig = {} }) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      throw new Error('Valid HTTP/HTTPS URL is required');
    }

    // 1. Fetch live page HTML
    const pageRes = await this.fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeoutMs: 15000,
      attempts: 2
    });

    if (!pageRes.ok) {
      throw new Error(`Failed to fetch target URL: HTTP ${pageRes.status}`);
    }

    const rawHtml = await pageRes.text();
    const prunedSnippet = this.pruneHtml(rawHtml);

    if (!prunedSnippet || prunedSnippet.length < 50) {
      throw new Error('Target webpage returned an empty or unparseable HTML document');
    }

    const systemPrompt = `You are a specialist web scraper engineer.
Analyze the provided HTML snippet of a sports replay website and identify the CSS selectors needed to parse match replay cards using Cheerio in Node.js.
Respond strictly with a JSON object following this format:
{
  "name": "lowercase alphanumeric slug (e.g. nbareplay)",
  "displayName": "User-friendly name (e.g. NBA Replays)",
  "category": "football | basketball | motorsport | hockey | baseball | american_football | other",
  "selectors": {
    "matches": "CSS selector for repeating match card containers (e.g. article.post, .match-item, div.video-card)",
    "title": "CSS selector relative to card for title (e.g. h2.title a, .match-title)",
    "link": "CSS selector relative to card for detail URL (e.g. h2.title a -> href, a.watch -> href)",
    "time": "Optional CSS selector relative to card for date or time",
    "thumbnail": "Optional CSS selector relative to card for poster image (e.g. img -> src)"
  },
  "videoExtractor": "auto | okru | dailymotion | sprintcdn | byse | direct_mp4"
}
Do NOT include explanations or markdown fences. Output pure JSON only.`;

    // 2. First Turn: LLM Analysis
    const prompt = `Webpage URL: ${url}\n\nHTML Snippet:\n${prunedSnippet}`;
    const rawAnswer = await this.queryLlm({ prompt, systemPrompt, config: aiConfig });
    let parserConfig = this.parseJsonFromResponse(rawAnswer);

    // Normalize config
    parserConfig.baseUrl = url;
    if (!parserConfig.name) {
      parserConfig.name = new URL(url).hostname.replace(/[^a-z0-9]/gi, '').toLowerCase();
    }

    // 3. Self-validation test loop
    let testResult = this.testSelectors(rawHtml, parserConfig.selectors, url);

    // 4. One-shot auto-correction loop if the first attempt extracted 0 items
    if (!testResult.valid) {
      console.warn(`[AiParserGenerator] First selector candidate failed (${testResult.error}). Requesting LLM correction...`);
      const correctionPrompt = `The previous selectors failed with error: "${testResult.error}".
Previous selectors: ${JSON.stringify(parserConfig.selectors)}
Please re-examine the HTML carefully and return revised, valid selectors that will match the repeating match cards.
HTML Snippet:
${prunedSnippet}`;

      try {
        const revisedAnswer = await this.queryLlm({ prompt: correctionPrompt, systemPrompt, config: aiConfig });
        const revisedConfig = this.parseJsonFromResponse(revisedAnswer);
        const secondTest = this.testSelectors(rawHtml, revisedConfig.selectors, url);
        if (secondTest.valid) {
          parserConfig = { ...parserConfig, ...revisedConfig };
          testResult = secondTest;
          console.log('[AiParserGenerator] Self-correction succeeded on second attempt!');
        }
      } catch (correctionErr) {
        console.warn(`[AiParserGenerator] Correction attempt threw: ${correctionErr.message}`);
      }
    }

    if (!testResult.valid) {
      throw new Error(`Generated selectors failed validation: ${testResult.error || '0 items matched'}`);
    }

    return {
      success: true,
      providerConfig: parserConfig,
      preview: {
        totalFound: testResult.count,
        sample: testResult.sample
      }
    };
  }
}

module.exports = AiParserGeneratorService;
