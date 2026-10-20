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
const SpaHydrator = require('./SpaHydrator');

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
  pruneHtml(rawHtml, baseUrl = '') {
    if (!rawHtml || typeof rawHtml !== 'string') return '';
    const hydrated = SpaHydrator.hydrate(rawHtml, baseUrl);
    const $ = cheerio.load(hydrated);

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
   * Dispatches request to an LLM provider:
   * - Google Gemini (auto-detected via AIza* key or googleapis URL): uses OpenAI compatibility
   *   endpoint with automated multi-model cascade (gemini-2.5-flash -> gemini-2.0-flash -> etc.)
   *   and fallback to native Gemini generateContent REST API.
   * - OpenAI-compatible providers (OpenCode, Freebuff, OpenAI, Ollama, DeepSeek, vLLM).
   */
  async queryLlm({ prompt, systemPrompt, config = {} }) {
    const apiKey = config.apiKey !== undefined ? config.apiKey : this.defaultApiKey;
    let rawBaseUrl = config.baseUrl || this.defaultBaseUrl;

    const isGemini = (apiKey && apiKey.startsWith('AIza')) || 
                     (rawBaseUrl && rawBaseUrl.includes('generativelanguage.googleapis.com'));

    if (isGemini) {
      return this._queryGemini({ prompt, systemPrompt, apiKey, requestedModel: config.model });
    }

    return this._queryOpenAiCompatible({ 
      prompt, 
      systemPrompt, 
      apiKey, 
      rawBaseUrl, 
      model: config.model || this.defaultModel 
    });
  }

  /**
   * Resilient Google Gemini handler with automatic model cascading and native API fallback.
   */
  async _queryGemini({ prompt, systemPrompt, apiKey, requestedModel }) {
    // Models to attempt: prioritize current 3.8 / 3.5 / 2.5 generations
    const defaultGeminiCandidates = [
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash'
    ];
    const candidates = [];

    let normalizedRequested = requestedModel ? String(requestedModel).trim().toLowerCase() : '';
    if (normalizedRequested === '3.8 flash' || normalizedRequested === '3.8-flash' || normalizedRequested === 'gemini 3.8 flash' || normalizedRequested === '3.8') {
      normalizedRequested = 'gemini-3.8-flash';
    }

    if (normalizedRequested && 
        normalizedRequested !== 'deepseek-chat' && 
        !normalizedRequested.startsWith('gemini-1.5')) {
      candidates.push(normalizedRequested);
    }
    for (const c of defaultGeminiCandidates) {
      if (!candidates.includes(c)) candidates.push(c);
    }

    let lastError = null;

    // Strategy 1: Google Gemini OpenAI-compatible endpoint
    const openaiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    for (const modelCandidate of candidates) {
      try {
        const payload = {
          model: modelCandidate,
          temperature: 0.1,
          max_tokens: 1500,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ]
        };

        const res = await this._fetchLlm(openaiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent': 'Nuvio-AI-Parser-Studio/1.0'
          },
          body: JSON.stringify(payload),
          timeoutMs: 20000,
          attempts: 1
        });

        if (res.ok) {
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content;
          if (content) return content;
        }

        const errText = await res.text().catch(() => '');
        // If transient error (503 high demand, 429 rate limit, 404 model not found, timeout), cascade to next candidate
        if (this._isModelCascadable(res.status, errText)) {
          console.warn(`[AiParserGenerator] Gemini model '${modelCandidate}' returned HTTP ${res.status}. Cascading to next candidate...`);
          lastError = new Error(`Gemini model '${modelCandidate}' HTTP ${res.status}: ${errText.slice(0, 150)}`);
          continue;
        }

        // For non-cascadable client errors (e.g. 400 invalid API key), throw immediately
        throw new Error(`LLM API returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
      } catch (err) {
        if (this._isModelCascadable(0, err.message)) {
          console.warn(`[AiParserGenerator] Gemini model '${modelCandidate}' failed (${err.message}). Cascading to next candidate...`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    // Strategy 2: Google Gemini Native generateContent REST fallback
    for (const modelCandidate of candidates) {
      try {
        const nativeEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelCandidate}:generateContent?key=${apiKey}`;
        const nativePayload = {
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemPrompt}\n\n${prompt}` }]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1500,
            responseMimeType: 'application/json'
          }
        };

        const res = await this._fetchLlm(nativeEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Nuvio-AI-Parser-Studio/1.0'
          },
          body: JSON.stringify(nativePayload),
          timeoutMs: 20000,
          attempts: 1
        });

        if (res.ok) {
          const data = await res.json();
          const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (content) return content;
        }

        const errText = await res.text().catch(() => '');
        if (this._isModelCascadable(res.status, errText)) {
          console.warn(`[AiParserGenerator] Gemini native '${modelCandidate}' returned HTTP ${res.status}. Cascading to next candidate...`);
          lastError = new Error(`Gemini native '${modelCandidate}' HTTP ${res.status}: ${errText.slice(0, 150)}`);
          continue;
        }

        throw new Error(`LLM API returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
      } catch (err) {
        if (this._isModelCascadable(0, err.message)) {
          console.warn(`[AiParserGenerator] Gemini native '${modelCandidate}' failed (${err.message}). Cascading to next candidate...`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('All Google Gemini candidate models failed (High demand / Not Found / Timeout)');
  }

  /**
   * Dedicated fetcher for external LLM REST APIs:
   * Uses standard native fetch (with AbortSignal.timeout) to avoid browser-impersonation
   * (impit) timeouts and HTTP/2 proxy header delays on Google and OpenAI APIs.
   */
  async _fetchLlm(url, opts = {}) {
    if (this.fetchFn && this.fetchFn !== safeFetch) {
      return await this.fetchFn(url, opts);
    }

    const { timeoutMs = 20000, headers = {}, body, method = 'POST' } = opts;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

    try {
      const fetcher = globalThis.fetch || safeFetch;
      if (fetcher === safeFetch) {
        return await safeFetch(url, { ...opts, timeoutMs });
      }

      const res = await fetcher(url, { method, headers, body, signal });
      return {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        text: async () => await res.text(),
        json: async () => await res.json()
      };
    } catch (err) {
      if (err.name === 'TimeoutError' || (err.message && err.message.toLowerCase().includes('aborted'))) {
        throw new Error(`HTTP timeout after ${timeoutMs}ms querying LLM API`);
      }
      throw err;
    }
  }

  /**
   * Identifies if an HTTP response code or error message represents a model-specific or transient issue
   * that should trigger automated cascade to another candidate model.
   */
  _isModelCascadable(status, errText = '') {
    if ([404, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }
    const lower = String(errText).toLowerCase();
    return lower.includes('not found') || 
           lower.includes('not supported') || 
           lower.includes('high demand') || 
           lower.includes('unavailable') || 
           lower.includes('resource_exhausted') || 
           lower.includes('rate limit') ||
           lower.includes('timeout') ||
           lower.includes('timed out') ||
           lower.includes('abort') ||
           lower.includes('econnreset') ||
           lower.includes('etimedout') ||
           lower.includes('503');
  }

  /**
   * Standard OpenAI-compatible /chat/completions query.
   */
  async _queryOpenAiCompatible({ prompt, systemPrompt, apiKey, rawBaseUrl, model }) {
    const cleanBaseUrl = (rawBaseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const endpoint = cleanBaseUrl.endsWith('/chat/completions') 
      ? cleanBaseUrl 
      : `${cleanBaseUrl}/chat/completions`;

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
      max_tokens: 1500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    };

    const res = await this._fetchLlm(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeoutMs: 25000,
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
      const hydrated = SpaHydrator.hydrate(html, baseUrl);
      const $ = cheerio.load(hydrated);
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
    const prunedSnippet = this.pruneHtml(rawHtml, url);

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
