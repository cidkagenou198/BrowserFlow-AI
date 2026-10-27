'use strict';

/**
 * Website Automation Agent — Natural Language Mode
 * =================================================
 * Accepts plain-English instructions and executes them in a browser.
 *
 * Instruction examples:
 *   "Open https://shadcn.com/form and fill name with John Doe and bio with Hello"
 *   "Go to https://google.com and search for playwright automation"
 *   "Navigate to https://github.com and click on Sign In"
 *
 * Usage (standalone): node agent.js "your instruction here"
 * Usage (server):     const { runAgent } = require('./agent')
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Load .env File ───────────────────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('#') || !line.includes('=')) continue;
      const delimIdx = line.indexOf('=');
      const key = line.slice(0, delimIdx).trim();
      let val = line.slice(delimIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
} catch (err) {
  // Silent fallback
}

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const LOG_DIR        = path.join(__dirname, 'logs');

// Ensure log directory exists on module load
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error(`Failed to create log directory: ${err.message}`);
}

// ─────────────────────────────────────────────
// AI Client  (Gemini · OpenRouter · Grok/xAI)
// ─────────────────────────────────────────────
class AIClient {
  constructor(provider, apiKeys, log) {
    this.provider = provider || 'none';
    this.apiKeys  = apiKeys  || {};
    this._log     = log || (() => {});
  }

  /** Whether an AI provider is configured and has an API key */
  get available() {
    if (this.provider === 'none') return false;
    const keyMap = { gemini: 'gemini', openrouter: 'openrouter', grok: 'grok' };
    const keyName = keyMap[this.provider];
    if (!keyName || !this.apiKeys[keyName]) {
      this._log('warning', `⚠  AI provider "${this.provider}" selected but no API key provided — falling back to regex parser.`);
      return false;
    }
    return true;
  }

  /**
   * Send a prompt (and optional base64 screenshot) to the configured AI provider.
   * @param {string} prompt
   * @param {string|null} b64 - Optional base64-encoded PNG screenshot
   * @returns {Promise<string>} AI response text, or empty string on failure
   */
  async analyze(prompt, b64 = null) {
    if (!this.available) return '';
    try {
      switch (this.provider) {
        case 'gemini':     return await this._callGemini(prompt, b64);
        case 'openrouter': return await this._callOpenRouter(prompt, b64);
        case 'grok':       return await this._callGrok(prompt, b64);
        default:
          this._log('warning', `⚠  Unknown AI provider: "${this.provider}"`);
          return '';
      }
    } catch (err) {
      this._log('error', `AI call failed (${this.provider}): ${err.message}`);
      return '';
    }
  }

  async _callGemini(prompt, b64) {
    const key = this.apiKeys.gemini;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
    const parts = [{ text: prompt }];
    if (b64) parts.unshift({ inline_data: { mime_type: 'image/png', data: b64 } });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unable to read response body)');
      throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!json.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error('Gemini returned an unexpected response structure');
    }
    return json.candidates[0].content.parts[0].text;
  }

  async _callOpenRouter(prompt, b64) {
    const content = [];
    if (b64) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
    content.push({ type: 'text', text: prompt });
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKeys.openrouter}`,
        'HTTP-Referer': 'https://web-agent',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.apiKeys.openrouterModel || 'mistralai/mistral-7b-instruct:free',
        messages: [{ role: 'user', content }],
        max_tokens: 1024,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unable to read response body)');
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!json.choices?.[0]?.message?.content) {
      throw new Error('OpenRouter returned an unexpected response structure');
    }
    return json.choices[0].message.content;
  }

  async _callGrok(prompt, b64) {
    const content = [];
    if (b64) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
    content.push({ type: 'text', text: prompt });
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKeys.grok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-2-vision-1212',
        messages: [{ role: 'user', content }],
        max_tokens: 1024,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unable to read response body)');
      throw new Error(`Grok HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!json.choices?.[0]?.message?.content) {
      throw new Error('Grok returned an unexpected response structure');
    }
    return json.choices[0].message.content;
  }
}

// ─────────────────────────────────────────────
// Instruction Parser
// ─────────────────────────────────────────────

/**
 * Parse a plain-English instruction into a structured execution plan.
 * Uses AI if available, otherwise falls back to regex patterns.
 *
 * @param {string} instruction - The natural language instruction
 * @param {AIClient} ai - AI client instance
 * @param {Function} log - Logging function
 * @returns {Promise<{url: string|null, actions: Array}>}
 */
/**
 * Parse a plain-English instruction into a structured execution plan.
 * Uses AI if available, otherwise falls back to regex patterns.
 *
 * @param {string} instruction - The natural language instruction
 * @param {AIClient} ai - AI client instance
 * @param {Function} log - Logging function
 * @returns {Promise<{url: string|null, actions: Array}>}
 */
async function parseInstruction(instruction, ai, log) {
  log('info', `📝  Parsing instruction: "${instruction}"`);

  // ── AI parser ──────────────────────────────────────────────────────────
  if (ai.available) {
    log('info', `🤖  Using ${ai.provider} to parse instruction …`);
    const prompt = `You are a browser automation task planner. Convert this instruction into a JSON execution plan.

Instruction: "${instruction}"

Return ONLY valid JSON (no markdown, no explanation) using this schema:
{
  "url": "https://...",
  "actions": [
    {"type": "scroll", "direction": "down", "amount": 600},
    {"type": "fill",   "target": "name or label of the input field", "value": "text to type"},
    {"type": "click",  "target": "text or description of the element to click"},
    {"type": "double_click", "target": "element to double click"},
    {"type": "click_on_screen", "x": 100, "y": 200},
    {"type": "send_keys", "target": "optional element", "value": "keys to type"},
    {"type": "search", "query": "search text (for search boxes + Enter)"},
    {"type": "select", "target": "dropdown label", "value": "option to select"},
    {"type": "check",  "target": "checkbox or radio label to check"},
    {"type": "uncheck","target": "checkbox label to uncheck"},
    {"type": "wait",   "duration": 3000},
    {"type": "verify_text", "text": "expected text to assert on screen"},
    {"type": "screenshot", "label": "optional label"},
    {"type": "element_detection"}
  ]
}

Rules:
- url: the main URL to navigate to (required)
- actions: ordered list — do NOT include a navigate action for the main URL
- target: describe the element in plain English (e.g. "username field", "submit button", "search box")
- Keep it minimal — only include actions the instruction mentions
- element_detection: scan the page to identify and list form elements/fields`;

    try {
      const raw   = await ai.analyze(prompt);
      if (!raw || !raw.trim()) throw new Error('Empty AI response');
      const clean = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
      const plan  = JSON.parse(clean);
      if (!plan || typeof plan !== 'object') throw new Error('AI returned non-object JSON');
      if (!Array.isArray(plan.actions)) plan.actions = [];
      log('info', `✅  AI plan parsed: ${plan.actions.length} action(s) — URL: ${plan.url || '(none)'}`);
      return plan;
    } catch (err) {
      log('warning', `⚠  AI parse failed (${err.message}), falling back to regex …`);
    }
  }

  // ── Regex parser (no AI needed) ────────────────────────────────────────
  return parseInstructionRegex(instruction, log);
}

/**
 * Helper to clean target descriptions by stripping leading verbs and articles.
 */
function cleanTarget(raw) {
  let target = raw.trim();
  let safety = 20;
  while (safety-- > 0) {
    const prev = target;
    target = target.replace(/^(?:automatically|automatic|and|then|fill|set|type|enter|the|in)\b\s*/i, '');
    if (target === prev) break;
  }
  return target;
}

/**
 * Splits a command string by 'and', 'then', or commas, while ignoring any
 * occurrence within single or double quotes.
 */
function splitByCommands(text) {
  const parts = [];
  let current = '';
  let inQuote = false;
  let quoteChar = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ((c === '"' || c === "'") && (i === 0 || text[i-1] !== '\\')) {
      if (inQuote && c === quoteChar) {
        inQuote = false;
        quoteChar = null;
      } else if (!inQuote) {
        inQuote = true;
        quoteChar = c;
      }
    }

    if (!inQuote) {
      const rest = text.slice(i);
      if (rest.startsWith(' and then ')) {
        parts.push(current);
        current = '';
        i += 9;
        continue;
      } else if (rest.startsWith(' and ')) {
        parts.push(current);
        current = '';
        i += 4;
        continue;
      } else if (rest.startsWith(' then ')) {
        parts.push(current);
        current = '';
        i += 5;
        continue;
      } else if (c === ',') {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += c;
  }
  if (current) parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Regex-based instruction parser. Extracts URL, scroll, click, fill,
 * search, double_click, click_on_screen, check, uncheck, wait, select, and send_keys actions.
 * Supports split-line declarations, negations, and compound statements.
 */
function parseInstructionRegex(instruction, log = () => {}) {
  log('info', '🔍  Using robust regex parser …');
  const plan = { url: null, actions: [] };

  // ── 1. Extract URL (using same robust logic as before) ─────────────────
  let text = instruction.replace(/[\r\n]+/g, ' ');
  let urlMatchIndex = -1;
  let urlMatchLength = 0;
  const fullUrl = text.match(/https?:\/\/[^\s"',)]+/i);
  if (fullUrl) {
    plan.url = fullUrl[0].replace(/[.,;]+$/, '');
    urlMatchIndex = fullUrl.index;
    urlMatchLength = fullUrl[0].length;
  } else {
    const serviceMap = {
      'google forms': 'https://forms.google.com',
      'google form':  'https://forms.google.com',
      'youtube':      'https://youtube.com',
      'google':       'https://google.com',
      'gmail':        'https://mail.google.com',
      'github':       'https://github.com',
      'wikipedia':    'https://wikipedia.org',
      'reddit':       'https://reddit.com',
    };

    for (const key of Object.keys(serviceMap)) {
      const regex = new RegExp(`(?:open|go\\s+to|navigate\\s+to|visit|browse\\s+to)\\s+${key}\\b`, 'i');
      const m = text.match(regex);
      if (m) {
        plan.url = serviceMap[key];
        urlMatchIndex = m.index;
        urlMatchLength = m[0].length;
        break;
      }
    }

    if (!plan.url) {
      const domainRe = /(?:open|go\s+to|navigate\s+to|visit|browse\s+to)\s+((?:[a-z0-9][-a-z0-9]*\.)+[a-z]{2,}(?:\/[^\s,]*)?)/i;
      const dm = text.match(domainRe);
      if (dm) {
        plan.url = 'https://' + dm[1].replace(/[.,;]+$/, '');
        urlMatchIndex = dm.index;
        urlMatchLength = dm[0].length;
      }
    }
  }

  // ── 2. Line-by-line Command Parser State Machine ───────────────────────
  const lines = instruction.split(/\r?\n/);
  
  const negationRe = /\b(do\s+not|don\s*['’]?t|never|avoid|no)\b/i;
  
  // Specific label and type prefix regexes
  const labelPrefixRe = /\b(labeled|label|placeholder|named|name of|title of)\s*:?\s*$/i;
  const labelRe = /\b(labeled|label|placeholder|named|name of|title of)\s*:?\s*\n*\s*(?:["']([^"'\n]+)["']|([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+){0,2}))/i;
  
  const typePrefixRe = /^\s*(?:type|write|enter|fill|set)\s*:?\s*$/i;
  const typeCommandRe = /^\s*(?:type|write|enter|fill|set)\s*:?\s*(?:["']([^"'\n]+)["']|([^"'\n]+?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;

  // Action matchers
  const fillWithRe = /(?:and\s+|then\s+|fill\s+|set\s+|type\s+|write\s+|enter\s+|in\s+)+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))\s+(?:field\s+|input\s+)?(?:with|as|whith|whit)\s+(?:["']([^"'\n]+)["']|([^"'\n]+?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const inPlaceRe = /(?:in\s+the\s+pal?ce\s+of|in\s+the\s+place\s+of|in\s+place\s+of|for|into)\s+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))\s+(?:write|type|enter|fill|set)\s+(?:["']([^"'\n]+)["']|([^"'\n]+?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const typeInRe = /(?:type|write|enter|fill)\s+(?:["']([^"'\n]+)["']|([^"'\n]+?))\s+(?:in\s+the\s+pal?ce\s+of|in\s+the\s+place\s+of|in\s+place\s+of|into|in|to|for)\s+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const typeRe = /(?:type|enter)\s+(?:["']([^"'\n]+)["']|([^"'\n]+?))\s+in(?:to)?\s+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const setRe = /set\s+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))\s+(?:field\s+)?(?:to|as)\s+(?:["']([^"'\n]+)["']|([^"',\n]+?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;

  const clickRe = /\bclick\s+(?:on\s+)?(?:the\s+)?(?:["']([^"'\n]+)["']|([^"',\n]+?))\s*(?:button|link|tab)?(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const waitRe = /\bwait\s+(?:for\s+)?(\d+)\s*(s|sec|seconds?|ms|milliseconds?)\b/i;
  const verifyRe = /\b(?:verify|assert|confirm)\s+(?:that\s+)?(?:text\s+)?(?:["']([^"'\n]+)["']|([^"'\n]+?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  
  const selectFromRe = /(?:select|choose)\s+(?:["']([^"'\n]+)["']|([^"'\n\s]+?))\s+from\s+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const selectAsRe = /(?:select|choose)\s+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))\s+(?:as|to)\s+(?:["']([^"'\n]+)["']|([^"'\n]+?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const chooseInRe = /(?:select|choose)\s+(?:["']([^"'\n]+)["']|([^"'\n\s]+?))\s+in\s+(?:the\s+)?(?:["']([^"'\n]+)["']|((?:(?!and\b|then\b|select\b|choose\b|check\b|uncheck\b|wait\b|verify\b|click\b|search\b|type\b|write\b|enter\b|fill\b|set\b|send\b)[a-z0-9_-])(?:(?!and\b|then\b)[\w\s-])*?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  
  const checkRe = /\b(check|uncheck|tick|untick)\s+(?:the\s+)?(?:checkbox\s+|box\s+)?(?:for\s+)?(?:["']([^"'\n]+)["']|([^"'\n]+?))\s*(?:checkbox|box|radio)?(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const dblClickRe = /double\s*click\s+(?:on\s+)?(?:the\s+)?(?:["']([^"'\n]+)["']|([^"',\n]+?))\s*(?:button|link|tab)?(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const clickScreenRe = /(?:click\s+(?:on\s+screen\s+)?at\s+)(\d+)[\s,]+(\d+)/i;
  const scrollRe = /\bscroll\s+(down|up)\b/i;
  const searchRe = /\b(?:search|look|query)\s+(?:for\s+)?(?:["']([^"'\n]+)["']|([^"'\n]+?))(?=\s+and\s+|\s+then\s+|,|\.?\s*$)/i;
  const navigateRe = /\b(?:go\s+to|navigate\s+to|open|visit|browse\s+to)\s+(https?:\/\/[^\s"',)]+)/i;

  const filledValues = {};

  let currentTarget = null;
  let waitingForValue = false;
  let waitingForTarget = false;
  let inVerifyBlock = false;
  let lastMentionedTarget = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Check if line starts another action. If so, reset verify block.
    if (inVerifyBlock) {
      const isBullet = /^\s*[-*+•\d]/i.test(trimmedLine);
      const cleanLineNoNum = trimmedLine.replace(/^\d+[\s.)]*/, '').trim();
      const isAction = /^(?:click|fill|type|set|select|choose|navigate|go\s+to|open|wait)\b/i.test(cleanLineNoNum);
      if (isAction && !isBullet) {
        inVerifyBlock = false;
      }
    }

    // Toggle verify block
    if (/\b(?:verify|assert|confirm|check\s+that)\b/i.test(trimmedLine)) {
      inVerifyBlock = true;
    }

    // Line-level verify check
    if (inVerifyBlock) {
      const isBullet = /^\s*[-*+•\d]/i.test(trimmedLine);
      const hasVerifyWord = /\b(?:verify|assert|confirm|check\s+that)\b/i.test(trimmedLine);
      
      if (isBullet || hasVerifyWord) {
        const verifyBulletRe = /^(?:[-*+•\d\s.]*)\s*(.*?)\s+(?:contains|is|has|contains\s+text|should\s+be|should\s+contain)\s+(.*)/i;
        const m = trimmedLine.match(verifyBulletRe);
        if (m && !/\b(?:verify|assert|confirm|check\s+that)\b/i.test(m[1])) {
          const field = m[1].trim();
          let rawVal = m[2].trim();
          let val = rawVal.replace(/^["']|["']$/g, '');
          
          // Reference resolution
          if (!rawVal.startsWith('"') && !rawVal.startsWith("'")) {
            const keys = Object.keys(filledValues);
            const matchingKey = keys.find(k => val.toLowerCase().includes(k) || k.includes(val.toLowerCase()));
            if (matchingKey) {
              val = filledValues[matchingKey];
            }
          }
          
          plan.actions.push({ type: 'verify_text', text: val });
          continue;
        }
      }
    }

    // Split line into separate command clauses
    const clauses = splitByCommands(trimmedLine);
    for (const clause of clauses) {
      if (!clause) continue;

      // Check if clause mentions an ordinal target or element, to resolve "it" references later
      const mentionMatch = clause.match(/(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|\d+(?:st|nd|rd|th)?)\s+(result|video|link|button|input|field|checkbox)/i);
      if (mentionMatch) {
        lastMentionedTarget = mentionMatch[0];
      }

      // Check negation outside of quotes
      const noQuotes = clause.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
      if (negationRe.test(noQuotes)) {
        continue;
      }

      if (waitingForTarget) {
        currentTarget = clause.replace(/^["']|["']$/g, '').trim();
        waitingForTarget = false;
        continue;
      }

      if (waitingForValue) {
        const val = clause.replace(/^["']|["']$/g, '').trim();
        if (currentTarget) {
          const cleanTgt = cleanTarget(currentTarget);
          plan.actions.push({ type: 'fill', target: cleanTgt, value: val });
          filledValues[cleanTgt.toLowerCase()] = val;
          currentTarget = null;
        } else {
          plan.actions.push({ type: 'send_keys', value: val });
        }
        waitingForValue = false;
        continue;
      }

      // Check URL navigation (only if not yet set)
      const urlMatch = clause.match(/https?:\/\/[^\s"',)]+/i);
      if (urlMatch && !plan.url) {
        plan.url = urlMatch[0].replace(/[.,;]+$/, '');
        continue;
      }

      // Explicit Wait
      const waitMatch = clause.match(waitRe);
      if (waitMatch) {
        const val = parseInt(waitMatch[1]);
        const unit = waitMatch[2].toLowerCase();
        const duration = unit.startsWith('s') ? val * 1000 : val;
        plan.actions.push({ type: 'wait', duration });
        continue;
      }

      // Verify Text
      const verifyMatch = clause.match(verifyRe);
      if (verifyMatch) {
        const txt = (verifyMatch[1] || verifyMatch[2]).trim().replace(/[:.]+$/, '');
        if (txt.toLowerCase() !== 'that' && txt.toLowerCase() !== 'this' && txt.length > 0) {
          plan.actions.push({ type: 'verify_text', text: txt });
        }
        continue;
      }

      // Self-contained fills
      let filled = false;
      const fillMatches = [
        clause.match(fillWithRe),
        clause.match(inPlaceRe),
        clause.match(typeInRe),
        clause.match(typeRe),
        clause.match(setRe),
      ];
      for (const m of fillMatches) {
        if (m) {
          const tgt = (m[1] || m[2]).trim();
          const val = (m[3] || m[4]).trim();
          const cleanTgt = cleanTarget(tgt);
          plan.actions.push({ type: 'fill', target: cleanTgt, value: val });
          filledValues[cleanTgt.toLowerCase()] = val;
          filled = true;
          break;
        }
      }
      if (filled) continue;

      // Dropdown selects
      let selected = false;
      const selectMatches = [
        clause.match(selectFromRe),
        clause.match(selectAsRe),
        clause.match(chooseInRe),
      ];
      for (const m of selectMatches) {
        if (m) {
          const val = (m[1] || m[2]).trim();
          const tgt = (m[3] || m[4]).trim();
          plan.actions.push({ type: 'select', target: cleanTarget(tgt), value: val });
          selected = true;
          break;
        }
      }
      if (selected) continue;

      // Check / uncheck
      const checkMatch = clause.match(checkRe);
      if (checkMatch) {
        const actionType = (checkMatch[1].toLowerCase() === 'uncheck' || checkMatch[1].toLowerCase() === 'untick') ? 'uncheck' : 'check';
        const tgt = (checkMatch[2] || checkMatch[3]).trim();
        plan.actions.push({ type: actionType, target: tgt });
        continue;
      }

      // Scroll
      const scrollMatch = clause.match(scrollRe);
      if (scrollMatch) {
        plan.actions.push({ type: 'scroll', direction: scrollMatch[1].toLowerCase(), amount: 600 });
        continue;
      }

      // Element detection (must come before search to avoid "search for elements" being caught as a search action)
      if (/\b(?:identify|detect|find|search\s+for)\s+(?:the\s+)?(?:form\s+)?(?:elements|fields|inputs)\b/i.test(clause)) {
        plan.actions.push({ type: 'element_detection' });
        continue;
      }

      // Search action (e.g. "search for playwright automation")
      const searchMatch = clause.match(searchRe);
      if (searchMatch) {
        const query = (searchMatch[1] || searchMatch[2]).trim().replace(/["']+$/g, '');
        if (query && query.length > 0) {
          plan.actions.push({ type: 'search', query });
          continue;
        }
      }

      // Navigate to additional URL mid-instruction (e.g. "then go to https://...")
      const navigateMatch = clause.match(navigateRe);
      if (navigateMatch) {
        const navUrl = navigateMatch[1].replace(/[.,;]+$/, '');
        // Only add a navigate action if it's a different URL from the primary one
        if (navUrl !== plan.url) {
          plan.actions.push({ type: 'navigate', url: navUrl });
        }
        continue;
      }

      // Double Click
      const dblClickMatch = clause.match(dblClickRe);
      if (dblClickMatch) {
        const tgt = (dblClickMatch[1] || dblClickMatch[2]).trim();
        plan.actions.push({ type: 'double_click', target: tgt });
        continue;
      }

      // Click on screen
      const clickScreenMatch = clause.match(clickScreenRe);
      if (clickScreenMatch) {
        plan.actions.push({ type: 'click_on_screen', x: parseInt(clickScreenMatch[1]), y: parseInt(clickScreenMatch[2]) });
        continue;
      }

      // Target prefix check
      if (labelPrefixRe.test(clause)) {
        waitingForTarget = true;
        continue;
      }

      // Target label match on same line
      const labelMatch = clause.match(labelRe);
      if (labelMatch) {
        currentTarget = (labelMatch[2] || labelMatch[3]).trim();
        continue;
      }

      // Typing prefix check
      if (typePrefixRe.test(clause)) {
        waitingForValue = true;
        continue;
      }

      // Typing command with value on same line
      const typeMatch = clause.match(typeCommandRe);
      if (typeMatch) {
        const val = (typeMatch[1] || typeMatch[2]).trim();
        if (currentTarget) {
          const cleanTgt = cleanTarget(currentTarget);
          plan.actions.push({ type: 'fill', target: cleanTgt, value: val });
          filledValues[cleanTgt.toLowerCase()] = val;
          currentTarget = null;
        } else {
          plan.actions.push({ type: 'send_keys', value: val });
        }
        continue;
      }

      // Click action
      const clickMatch = clause.match(clickRe);
      if (clickMatch) {
        let target = (clickMatch[1] || clickMatch[2]).trim();
        if (/(?:inside|in|on)\s+(?:the\s+)?(?:field|textarea|input|box|here)/i.test(target)) {
          continue;
        }
        if (/^(?:it|it\s+to\s+play|on\s+it|on\s+it\s+to\s+play)$/i.test(target) && lastMentionedTarget) {
          target = lastMentionedTarget;
        }
        plan.actions.push({ type: 'click', target });
        continue;
      }
    }
  }

  log('info', `✅  Regex parsed: ${plan.actions.length} action(s) — URL: ${plan.url || '(none)'}`);
  return plan;
}

// ─────────────────────────────────────────────
// Element Finder
// ─────────────────────────────────────────────

/**
 * Escapes special characters for use in regular expressions.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a page element using multiple strategies, given a plain-text hint.
 * Falls back through synonym mappings if the exact hint doesn't match.
 *
 * @param {import('playwright').Page} page
 * @param {string} hint - Plain-text description of the element
 * @returns {Promise<import('playwright').Locator|string|null>}
 */
async function findElement(page, hint) {
  if (!page || !hint) return null;
  const h = hint.toLowerCase().trim();
  if (!h) return null;

  // 1. Try finding with the exact hint in page and subframes
  let el = await findElementInContexts(page, hint);
  if (el) return el;

  // 2. Try common synonyms
  const synonyms = {
    'bio':         ['more about you', 'about me', 'about', 'biography', 'description', 'discription'],
    'description': ['bio', 'desc', 'more about you', 'about', 'discription'],
    'discription': ['bio', 'desc', 'more about you', 'about', 'description'],
    'name':        ['username', 'full name', 'first name', 'user'],
    'username':    ['name', 'user'],
    'title':       ['subject', 'bug title', 'header'],
    'email':       ['email address', 'e-mail', 'mail'],
    'password':    ['pass', 'passwd', 'secret'],
    'phone':       ['telephone', 'mobile', 'cell', 'phone number'],
    'message':     ['comment', 'feedback', 'note', 'body'],
  };

  const keys = Object.keys(synonyms);
  const matchedKey = keys.find(k => h.includes(k) || k.includes(h));
  if (matchedKey) {
    for (const syn of synonyms[matchedKey]) {
      if (syn.toLowerCase() === h) continue; // skip self
      el = await findElementInContexts(page, syn);
      if (el) return el;
    }
  }

  return null;
}

/**
 * Helper to search the main page/frame and all subframes flatly.
 */
async function findElementInContexts(page, hint) {
  // First check main page
  let el = await findElementRaw(page, hint);
  if (el) return el;

  // Otherwise, flatly check all subframes
  if (page && typeof page.frames === 'function') {
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue; // already checked top level
      try {
        const elInFrame = await findElementRaw(frame, hint);
        if (elInFrame) {
          if (typeof elInFrame === 'string') {
            return frame.locator(elInFrame);
          }
          return elInFrame;
        }
      } catch (e) {
        // frame detached or navigation occurred
      }
    }
  }
  return null;
}

/**
 * Raw element finder — tries Playwright semantic locators, then CSS attribute selectors.
 * Supports direct selector inputs, regex escaping, and full-phrase checking.
 * @param {import('playwright').Page|import('playwright').Frame} pageOrFrame
 * @param {string} hint
 * @returns {Promise<import('playwright').Locator|string|null>}
 */
async function findElementRaw(pageOrFrame, hint) {
  if (!pageOrFrame || !hint) return null;
  const h = hint.toLowerCase().trim();

  // Strategy 0: Support Direct CSS or XPath inputs
  if (hint.startsWith('/') || hint.startsWith('xpath=') || hint.startsWith('//') || hint.startsWith('.') || hint.startsWith('#') || hint.includes('>') || hint.includes('[') || hint.startsWith('css=')) {
    try {
      let cleanSel = hint;
      if (cleanSel.startsWith('css=')) cleanSel = cleanSel.slice(4);
      if (cleanSel.startsWith('xpath=')) cleanSel = cleanSel.slice(6);
      const el = pageOrFrame.locator(cleanSel);
      if (await el.count() > 0) return el.first();
    } catch (e) {
      // not a valid selector, fallback to standard semantic find
    }
  }

  // Special targets for nth result/video/link
  const nthMatch = h.match(/(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|\d+(?:st|nd|rd|th)?)\s+(result|video|link)/i);
  if (nthMatch || h.includes('first result') || h.includes('first video') || h.includes('first link')) {
    let url;
    try { url = pageOrFrame.url(); } catch { return null; }

    const ordinalStr = nthMatch ? nthMatch[1].toLowerCase() : 'first';
    let targetIndex = 0;
    const map = {
      'first': 0, 'second': 1, 'third': 2, 'fourth': 3, 'fifth': 4,
      'sixth': 5, 'seventh': 6, 'eighth': 7, 'ninth': 8, 'tenth': 9,
      'eleventh': 10, 'twelfth': 11, 'thirteenth': 12, 'fourteenth': 13, 'fifteenth': 14,
      'sixteenth': 15, 'seventeenth': 16, 'eighteenth': 17, 'nineteenth': 18, 'twentieth': 19
    };
    if (map[ordinalStr] !== undefined) {
      targetIndex = map[ordinalStr];
    } else {
      const num = parseInt(ordinalStr);
      if (!isNaN(num) && num > 0) targetIndex = num - 1;
    }

    if (url.includes('youtube.com')) {
      // YouTube's SPA renders search results asynchronously — give it extra time
      const ytSelectors = [
        'ytd-video-renderer a#video-title',
        'ytd-video-renderer #video-title-link',
        'ytd-video-renderer h3 a',
        'ytd-video-renderer #dismissible a',
        'a#video-title',
        'a[href*="/watch?v="]',
        'ytd-rich-item-renderer a#video-title-link',
        'ytd-rich-item-renderer a#video-title',
      ];
      // Wait longer for YouTube's JS to render search results
      try {
        await Promise.any(
          ytSelectors.map(sel => pageOrFrame.waitForSelector(sel, { state: 'visible', timeout: 12000 }))
        );
      } catch { /* timeout is acceptable */ }
      // Additional settle time for YouTube's dynamic rendering
      try { await pageOrFrame.waitForTimeout(2000); } catch {}
      for (const sel of ytSelectors) {
        try {
          const loc = pageOrFrame.locator(sel);
          let count = await loc.count();
          if (count <= targetIndex) {
            for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt++) {
              if (typeof pageOrFrame.evaluate === 'function') {
                await pageOrFrame.evaluate(() => window.scrollBy(0, 800));
              }
              await pageOrFrame.waitForTimeout(1000);
              count = await loc.count();
              if (count > targetIndex) break;
            }
          }
          if (count > targetIndex) {
            const targetEl = loc.nth(targetIndex);
            await targetEl.scrollIntoViewIfNeeded().catch(() => {});
            return targetEl;
          }
        } catch { /* page closed */ }
      }
    }

    if (url.includes('google.com')) {
      const gSelectors = ['#search a h3', 'a h3', 'div.g a'];
      try {
        await Promise.any(
          gSelectors.map(sel => pageOrFrame.waitForSelector(sel, { state: 'visible', timeout: 8000 }))
        );
      } catch { /* timeout is acceptable */ }
      for (const sel of gSelectors) {
        try {
          const loc = pageOrFrame.locator(sel);
          let count = await loc.count();
          if (count <= targetIndex) {
            for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt++) {
              if (typeof pageOrFrame.evaluate === 'function') {
                await pageOrFrame.evaluate(() => window.scrollBy(0, 800));
              }
              await pageOrFrame.waitForTimeout(1000);
              count = await loc.count();
              if (count > targetIndex) break;
            }
          }
          if (count > targetIndex) {
            const targetEl = loc.nth(targetIndex);
            await targetEl.scrollIntoViewIfNeeded().catch(() => {});
            return targetEl;
          }
        } catch { /* page closed */ }
      }
    }

    const genericSelectors = [
      'a[href*="/watch?v="]', 'h3 a', '.result a',
      '.search-result a', 'article a', 'main a',
    ];
    try {
      await Promise.any(
        genericSelectors.map(sel => pageOrFrame.waitForSelector(sel, { state: 'attached', timeout: 3000 }))
      );
    } catch { /* timeout is acceptable */ }
    for (const sel of genericSelectors) {
      try {
        const loc = pageOrFrame.locator(sel);
        let count = await loc.count();
        if (count <= targetIndex) {
          for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt++) {
            if (typeof pageOrFrame.evaluate === 'function') {
              await pageOrFrame.evaluate(() => window.scrollBy(0, 800));
            }
            await pageOrFrame.waitForTimeout(1000);
            count = await loc.count();
            if (count > targetIndex) break;
          }
        }
        if (count > targetIndex) {
          const targetEl = loc.nth(targetIndex);
          await targetEl.scrollIntoViewIfNeeded().catch(() => {});
          return targetEl;
        }
      } catch { /* page closed */ }
    }
  }

  // Strategy 1 — Playwright semantic locators (with escaped RegExp and radio/checkbox role handling)
  const escapedHint = escapeRegExp(h);
  const tries = [
    () => pageOrFrame.getByLabel(hint, { exact: false }),
    () => pageOrFrame.getByPlaceholder(hint, { exact: false }),
    () => pageOrFrame.getByRole('textbox',  { name: new RegExp(escapedHint, 'i') }),
    () => pageOrFrame.getByRole('button',   { name: new RegExp(escapedHint, 'i') }),
    () => pageOrFrame.getByRole('link',     { name: new RegExp(escapedHint, 'i') }),
    () => pageOrFrame.getByRole('combobox', { name: new RegExp(escapedHint, 'i') }),
    () => pageOrFrame.getByRole('checkbox', { name: new RegExp(escapedHint, 'i') }),
    () => pageOrFrame.getByRole('radio',    { name: new RegExp(escapedHint, 'i') }),
    () => pageOrFrame.getByText(hint, { exact: false }),
  ];

  for (const get of tries) {
    try {
      const loc = get();
      if (await loc.count() > 0) return loc.first();
    } catch { /* locator strategy not applicable */ }
  }

  // Strategy 1.5 — CSS attribute selector using the full phrase
  const selTags  = ['input', 'textarea', 'button', 'a', 'select'];
  const selAttrs = ['name', 'id', 'placeholder', 'aria-label', 'data-testid', 'type'];
  const cleanHint = h.replace(/[^a-z0-9_-]/g, '');

  for (const attr of selAttrs) {
    for (const tag of selTags) {
      try {
        const sel = `${tag}[${attr}*="${h}" i]`;
        if (await pageOrFrame.$(sel)) return sel;
      } catch {}
      if (cleanHint && cleanHint !== h) {
        try {
          const sel = `${tag}[${attr}*="${cleanHint}" i]`;
          if (await pageOrFrame.$(sel)) return sel;
        } catch {}
      }
    }
  }

  // Strategy 2 — CSS attribute selectors on each keyword
  const keywords = h.split(/[\s/,]+/).filter(w => w.length >= 3);

  for (const kw of keywords) {
    for (const attr of selAttrs) {
      for (const tag of selTags) {
        try {
          const sel = `${tag}[${attr}*="${kw}" i]`;
          const el  = await pageOrFrame.$(sel);
          if (el) return sel;
        } catch { /* page closed or selector invalid */ }
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Action Executor
// ─────────────────────────────────────────────

/**
 * Execute a single action from the plan.
 * @param {Object} action - Action descriptor from the plan
 * @param {BrowserTools} tools - Browser tools instance
 * @param {Function} log - Logging function
 * @returns {Promise<boolean>} Whether the action succeeded
 */
async function executeAction(action, tools, log) {
  if (!tools.page) {
    log('error', '  ❌  Browser page is not available');
    return false;
  }
  const page = tools.page;

  /**
   * Helper: move the visual cursor to an element, highlight it, then pause.
   * This makes every action visible to the user watching the browser.
   */
  async function visualFocus(locator) {
    await tools.moveToElement(locator);
    await tools.highlightElement(locator);
  }

  switch (action.type) {

    case 'fill': {
      log('info', `⌨   Fill "${action.target}" ← "${action.value}"`);
      if (!action.target || !action.value) {
        log('warning', `  ⚠  Fill action missing target or value`);
        return false;
      }
      const el = await findElement(page, action.target);
      if (!el) { log('warning', `  ⚠  Could not find element: "${action.target}"`); return false; }
      const locator = (typeof el === 'string') ? page.locator(el) : el;
      try {
        await locator.waitFor({ timeout: 5_000 });
        await visualFocus(locator);
        try {
          await locator.fill('');
          await locator.pressSequentially(action.value, { delay: 80 });
        } catch (typeErr) {
          // direct fill fallback in case typing is locked
          await locator.fill(action.value);
        }
        try {
          await locator.blur();
        } catch (blurErr) {
          // Ignore if blur fails or element doesn't support blur
        }
        await page.waitForTimeout(500);
        log('info', `  ✅  Filled "${action.target}" with "${action.value}"`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Fill failed: ${err.message}`);
        return false;
      }
    }

    case 'click': {
      log('info', `🖱   Click "${action.target}"`);
      if (!action.target) { log('warning', '  ⚠  Click action missing target'); return false; }
      const el = await findElement(page, action.target);
      if (!el) { log('warning', `  ⚠  Could not find element: "${action.target}"`); return false; }
      const locator = (typeof el === 'string') ? page.locator(el) : el;
      try {
        await locator.waitFor({ timeout: 5_000 });
        await visualFocus(locator);
        try {
          await locator.click({ timeout: 4_000 });
        } catch (clickErr) {
          log('warning', `  ⚠  Standard click failed (${clickErr.message}), trying forced click …`);
          try {
            await locator.click({ force: true, timeout: 2000 });
          } catch (forceErr) {
            log('warning', `  ⚠  Forced click failed (${forceErr.message}), trying dispatchEvent click …`);
            await locator.dispatchEvent('click');
          }
        }
        await page.waitForTimeout(600);
        log('info', `  ✅  Clicked "${action.target}"`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Click failed: ${err.message}`);
        return false;
      }
    }

    case 'search': {
      log('info', `🔍  Search for "${action.query}"`);
      if (!action.query) { log('warning', '  ⚠  Search action missing query'); return false; }
      const searchSelectors = [
        'input[type="search"]', 'input[name="q"]', 'input[name="search"]',
        'input[placeholder*="search" i]', 'input[aria-label*="search" i]',
        'textarea[name="q"]', 'input[type="text"]',
      ];
      let found = false;
      for (const sel of searchSelectors) {
        try {
          const el = await findElementInContexts(page, sel);
          if (el) {
            const locator = (typeof el === 'string') ? page.locator(el) : el;
            await visualFocus(locator);
            await locator.fill('');
            await locator.pressSequentially(action.query, { delay: 80 });
            await page.waitForTimeout(500);
            await locator.press('Enter');
            await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
            // Extra wait for SPA sites (like YouTube) where content renders after network settles
            await page.waitForTimeout(3000);
            // Re-inject visual cursor after SPA navigation
            await tools.injectVisualCursor();
            log('info', `  ✅  Searched for "${action.query}"`);
            found = true;
            break;
          }
        } catch (err) {
          log('warning', `  ⚠  Search selector "${sel}" failed: ${err.message}`);
        }
      }
      if (!found) log('warning', '  ⚠  No search box found on this page');
      return found;
    }

    case 'scroll': {
      const dir    = action.direction || 'down';
      const amount = Math.min(Math.abs(action.amount || 500), 5000); // cap at 5000px
      log('info', `↕   Scroll ${dir} ${amount}px`);
      try {
        await page.mouse.wheel(0, dir === 'down' ? amount : -amount);
        await page.waitForTimeout(400);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Scroll failed: ${err.message}`);
        return false;
      }
    }

    case 'select': {
      log('info', `☰   Select "${action.value}" in "${action.target}"`);
      if (!action.target || !action.value) {
        log('warning', '  ⚠  Select action missing target or value');
        return false;
      }
      const el = await findElement(page, action.target);
      if (!el) { log('warning', `  ⚠  Dropdown not found: "${action.target}"`); return false; }
      const locator = (typeof el === 'string') ? page.locator(el) : el;
      try {
        await locator.waitFor({ timeout: 5_000 });
        await visualFocus(locator);
        
        // Dropdown fallback selection strategy
        try {
          await locator.selectOption({ label: action.value }, { timeout: 3000 });
        } catch (labelErr) {
          try {
            await locator.selectOption({ value: action.value }, { timeout: 2000 });
          } catch (valueErr) {
            const idx = parseInt(action.value, 10);
            if (!isNaN(idx)) {
              await locator.selectOption({ index: idx });
            } else {
              throw new Error('All dropdown select parameters exhausted.');
            }
          }
        }
        
        await page.waitForTimeout(400);
        log('info', `  ✅  Selected "${action.value}" in dropdown "${action.target}"`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Select failed: ${err.message}`);
        return false;
      }
    }

    case 'check':
    case 'uncheck': {
      const mode = action.type;
      log('info', `☑   ${mode === 'check' ? 'Check' : 'Uncheck'} "${action.target}"`);
      if (!action.target) { log('warning', `  ⚠  ${mode} action missing target`); return false; }
      const el = await findElement(page, action.target);
      if (!el) { log('warning', `  ⚠  Could not find checkbox/radio: "${action.target}"`); return false; }
      const locator = (typeof el === 'string') ? page.locator(el) : el;
      try {
        await locator.waitFor({ timeout: 5_000 });
        await visualFocus(locator);
        
        try {
          if (mode === 'check') {
            await locator.check({ timeout: 3000 });
          } else {
            await locator.uncheck({ timeout: 3000 });
          }
        } catch (err) {
          log('warning', `  ⚠  Standard check/uncheck failed, trying forced fallback …`);
          if (mode === 'check') {
            await locator.check({ force: true, timeout: 2000 }).catch(async () => {
              const isChecked = await locator.isChecked().catch(() => false);
              if (!isChecked) await locator.click({ force: true });
            });
          } else {
            await locator.uncheck({ force: true, timeout: 2000 }).catch(async () => {
              const isChecked = await locator.isChecked().catch(() => false);
              if (isChecked) await locator.click({ force: true });
            });
          }
        }
        
        await page.waitForTimeout(400);
        log('info', `  ✅  ${mode === 'check' ? 'Checked' : 'Unchecked'} "${action.target}"`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  ${mode} failed: ${err.message}`);
        return false;
      }
    }

    case 'wait': {
      const duration = Number(action.duration) || 1000;
      log('info', `⏳  Wait for ${duration}ms`);
      try {
        await page.waitForTimeout(duration);
        log('info', `  ✅  Waited ${duration}ms`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Wait failed: ${err.message}`);
        return false;
      }
    }

    case 'verify_text': {
      log('info', `🔍  Verifying page contains text: "${action.text}"`);
      if (!action.text) { log('warning', '  ⚠  verify_text action missing text'); return false; }
      try {
        let found = false;
        // Poll for text up to 5 seconds
        for (let attempt = 0; attempt < 10; attempt++) {
          const bodyText = await page.innerText('body').catch(() => '');
          if (bodyText.includes(action.text)) {
            found = true;
            break;
          }

          // Also check all input/textarea/select values on the page
          const inputValues = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input, textarea, select'))
              .map(el => el.value || '');
          }).catch(() => []);

          if (inputValues.some(val => val.includes(action.text))) {
            found = true;
            break;
          }

          await page.waitForTimeout(500);
        }
        
        if (found) {
          log('info', `  ✅  Text verified on page: "${action.text}"`);
          return true;
        } else {
          log('error', `  ❌  Text NOT found on page after timeout: "${action.text}"`);
          return false;
        }
      } catch (err) {
        log('warning', `  ⚠  Verify text failed: ${err.message}`);
        return false;
      }
    }

    case 'screenshot': {
      try {
        await tools.takeScreenshot(action.label || 'step');
        return true;
      } catch (err) {
        log('warning', `  ⚠  Screenshot failed: ${err.message}`);
        return false;
      }
    }

    case 'double_click': {
      log('info', `🖱   Double Click "${action.target}"`);
      if (!action.target) { log('warning', '  ⚠  Double click action missing target'); return false; }
      const el = await findElement(page, action.target);
      if (!el) { log('warning', `  ⚠  Could not find element: "${action.target}"`); return false; }
      const locator = (typeof el === 'string') ? page.locator(el) : el;
      try {
        await locator.waitFor({ timeout: 5_000 });
        await visualFocus(locator);
        try {
          await locator.dblclick({ timeout: 4_000 });
        } catch (clickErr) {
          log('warning', `  ⚠  Standard double click failed, trying forced double click …`);
          try {
            await locator.dblclick({ force: true, timeout: 2000 });
          } catch (forceErr) {
            log('warning', `  ⚠  Forced double click failed, trying dispatchEvent dblclick …`);
            await locator.dispatchEvent('dblclick');
          }
        }
        await page.waitForTimeout(600);
        log('info', `  ✅  Double Clicked "${action.target}"`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Double Click failed: ${err.message}`);
        return false;
      }
    }

    case 'click_on_screen': {
      const x = Number(action.x);
      const y = Number(action.y);
      if (isNaN(x) || isNaN(y)) {
        log('warning', '  ⚠  click_on_screen requires valid x and y coordinates');
        return false;
      }
      log('info', `🖱   Click on screen at (${x}, ${y})`);
      try {
        await page.mouse.move(x, y, { steps: 15 });
        await page.waitForTimeout(300);
        await page.mouse.click(x, y);
        await page.waitForTimeout(400);
        log('info', `  ✅  Clicked on screen at (${x}, ${y})`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Click on screen failed: ${err.message}`);
        return false;
      }
    }

    case 'send_keys': {
      log('info', `⌨   Send keys "${action.value}"`);
      if (!action.value) { log('warning', '  ⚠  send_keys action missing value'); return false; }
      try {
        if (action.target) {
          const el = await findElement(page, action.target);
          if (el) {
            const locator = (typeof el === 'string') ? page.locator(el) : el;
            await locator.waitFor({ timeout: 5_000 });
            await visualFocus(locator);
            try {
              await locator.press(action.value);
            } catch {
              await locator.pressSequentially(action.value, { delay: 80 });
            }
            try {
              await locator.blur();
            } catch (blurErr) {
              // Ignore
            }
            await page.waitForTimeout(500);
            log('info', `  ✅  Sent keys "${action.value}" to "${action.target}"`);
            return true;
          }
        }
        await page.keyboard.press(action.value).catch(async () => {
          await page.keyboard.insertText(action.value);
        });
        await page.waitForTimeout(500);
        log('info', `  ✅  Sent keys "${action.value}" globally`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Send keys failed: ${err.message}`);
        return false;
      }
    }

    case 'element_detection': {
      log('info', '📜  Scanning page for form elements …');
      try {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(600);

        const fields = await page.evaluate(() => {
          const results = [];
          const inputs = Array.from(document.querySelectorAll('input, textarea, select, button'));
          for (const el of inputs) {
            if (el.tagName === 'BUTTON' && el.type !== 'submit') continue;
            if (el.type === 'hidden') continue;
            
            let labelText = '';
            if (el.id) {
              const label = document.querySelector(`label[for="${el.id}"]`);
              if (label) labelText = label.textContent.trim();
            }
            if (!labelText) {
              const parentLabel = el.closest('label');
              if (parentLabel) labelText = parentLabel.textContent.trim();
            }
            if (!labelText && el.getAttribute('aria-label')) {
              labelText = el.getAttribute('aria-label');
            }

            results.push({
              tagName: el.tagName.toLowerCase(),
              id: el.id || '',
              name: el.name || '',
              type: el.type || '',
              placeholder: el.placeholder || '',
              labelText: labelText || '',
              value: el.value || ''
            });
          }
          return results;
        });

        log('info', '🔍  Searching for form fields …');
        const found = [];
        for (const f of fields) {
          const desc = f.labelText || f.placeholder || f.name || f.id;
          if (desc) {
            log('info', `   Found ${f.tagName} field: "${desc}" (name="${f.name}", id="${f.id}", placeholder="${f.placeholder}")`);
            found.push(desc);
          }
        }
        log('info', `✅  [element_detection] Found elements: [${found.join(', ')}]`);
        return true;
      } catch (err) {
        log('warning', `  ⚠  Element detection failed: ${err.message}`);
        return false;
      }
    }

    case 'navigate': {
      const navUrl = action.url;
      if (!navUrl) { log('warning', '  ⚠  Navigate action missing url'); return false; }
      log('info', `🔗  Navigating to: ${navUrl}`);
      try {
        await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
          log('warning', '⚠  Network idle timeout — page may still be loading');
        });
        const title = await page.title().catch(() => '(unknown)');
        log('info', `  ✅  Navigated to: ${title}`);
        await tools.injectVisualCursor();
        return true;
      } catch (err) {
        log('warning', `  ⚠  Navigation failed: ${err.message}`);
        return false;
      }
    }

    default:
      log('warning', `  ⚠  Unknown action type: "${action.type}" — skipping`);
      return false;
  }
}

// ─────────────────────────────────────────────
// Browser Tools
// ─────────────────────────────────────────────

/**
 * Wraps Playwright browser operations into named, single-responsibility methods.
 * Each method logs its action and returns a boolean or value indicating success.
 */
class BrowserTools {
  constructor(dir, log) {
    this.browser  = null;
    this.page     = null;
    this._count   = 0;
    this._dir     = dir;
    this._log     = log;
    this._headless = false;
  }

  /**
   * Launch a persistent Chromium browser instance.
   * Fallback to a temporary profile directory if the default is locked.
   * @param {boolean} headless - Whether to run in headless mode
   * @returns {Promise<boolean>}
   */
  async openBrowser(headless = false) {
    this._headless = headless;
    this._log('info', '🌐  Opening browser with persistent profile …');
    try {
      const userDataPath = path.join(__dirname, 'user_data');
      if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
      }
      try {
        this.browser = await chromium.launchPersistentContext(userDataPath, {
          headless,
          slowMo    : headless ? 0 : 300,
          viewport  : { width: 1280, height: 900 },
          userAgent : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
      } catch (launchErr) {
        if (launchErr.message.includes('lock') || launchErr.message.includes('user data directory is already in use')) {
          const tempPath = path.join(userDataPath, `profile_fallback_${Date.now()}`);
          this._log('warning', `⚠  Default browser profile is locked. Falling back to clean profile: ${tempPath}`);
          fs.mkdirSync(tempPath, { recursive: true });
          this.browser = await chromium.launchPersistentContext(tempPath, {
            headless,
            slowMo    : headless ? 0 : 300,
            viewport  : { width: 1280, height: 900 },
            userAgent : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          });
        } else {
          throw launchErr;
        }
      }
      const pages = this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

      // Clear cache and cookies for a fresh start each run
      try {
        await this.browser.clearCookies();
        this._log('info', '🧹  Cleared cookies and session data for fresh run.');
      } catch (clearErr) {
        this._log('warning', `⚠  Could not clear cache/cookies: ${clearErr.message}`);
      }

      this._log('info', '✅  Browser ready.');
      return true;
    } catch (err) {
      this._log('error', `❌  Failed to launch browser: ${err.message}`);
      return false;
    }
  }

  /**
   * Safely close the browser instance and reset references.
   */
  async closeBrowser() {
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (err) {
      this._log('warning', `⚠  Browser close error (non-fatal): ${err.message}`);
    } finally {
      this.browser = null;
      this.page    = null;
    }
    this._log('info', '🔒  Browser closed.');
  }

  /**
   * Inject a visible cursor overlay, click ripple animations, and element
   * highlight styles into the current page. This makes the automation
   * visually traceable — the user sees a glowing dot cursor that moves
   * to each element, a ripple burst on clicks, and a purple glow on targets.
   */
  async injectVisualCursor() {
    if (!this.page || this._headless) return;
    try {
      await this.page.evaluate(() => {
        // Prevent double-injection
        if (document.getElementById('__agent-cursor')) return;

        // ── Cursor dot ───────────────────────────────────────────────
        const cursor = document.createElement('div');
        cursor.id = '__agent-cursor';
        Object.assign(cursor.style, {
          position: 'fixed', zIndex: '2147483647',
          width: '20px', height: '20px', borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(124,58,237,0.9) 0%, rgba(168,85,247,0.4) 70%, transparent 100%)',
          boxShadow: '0 0 12px 4px rgba(124,58,237,0.5), 0 0 30px 8px rgba(124,58,237,0.2)',
          pointerEvents: 'none',
          transform: 'translate(-50%, -50%)',
          transition: 'left 0.25s cubic-bezier(0.2,0.8,0.2,1), top 0.25s cubic-bezier(0.2,0.8,0.2,1), opacity 0.3s',
          left: '-100px', top: '-100px', opacity: '1',
        });
        document.body.appendChild(cursor);

        // ── Track mouse position ─────────────────────────────────────
        document.addEventListener('mousemove', (e) => {
          cursor.style.left = e.clientX + 'px';
          cursor.style.top  = e.clientY + 'px';
        }, { passive: true });

        // ── Click ripple ─────────────────────────────────────────────
        document.addEventListener('mousedown', (e) => {
          // Pulse the cursor
          cursor.style.transform = 'translate(-50%, -50%) scale(1.8)';
          setTimeout(() => { cursor.style.transform = 'translate(-50%, -50%) scale(1)'; }, 300);

          // Create ripple burst
          const ripple = document.createElement('div');
          Object.assign(ripple.style, {
            position: 'fixed', zIndex: '2147483646',
            left: (e.clientX - 25) + 'px', top: (e.clientY - 25) + 'px',
            width: '50px', height: '50px', borderRadius: '50%',
            border: '3px solid rgba(124,58,237,0.8)',
            background: 'rgba(124,58,237,0.15)',
            pointerEvents: 'none',
            animation: '__agent-ripple 0.6s ease-out forwards',
          });
          document.body.appendChild(ripple);
          setTimeout(() => ripple.remove(), 700);
        }, { passive: true });

        // ── Inject keyframe animation ─────────────────────────────────
        const style = document.createElement('style');
        style.textContent = `
          @keyframes __agent-ripple {
            0%   { transform: scale(0.5); opacity: 1; }
            100% { transform: scale(3);   opacity: 0; }
          }
          @keyframes __agent-highlight-pulse {
            0%   { box-shadow: 0 0 0 0 rgba(124,58,237,0.6); }
            50%  { box-shadow: 0 0 0 8px rgba(124,58,237,0.2); }
            100% { box-shadow: 0 0 0 0 rgba(124,58,237,0); }
          }
          .__agent-highlight {
            outline: 3px solid rgba(124,58,237,0.8) !important;
            outline-offset: 2px !important;
            animation: __agent-highlight-pulse 1s ease-in-out !important;
          }
        `;
        document.head.appendChild(style);
      });
    } catch (err) {
      this._log('warning', `⚠  Could not inject visual cursor: ${err.message}`);
    }
  }

  /**
   * Smoothly move the mouse cursor to the centre of a target element.
   * Updates the coordinates of the visual cursor overlay directly.
   * @param {import('playwright').Locator|string} el
   */
  async moveToElement(el) {
    if (!this.page || this._headless) return;
    try {
      // Ensure the element is scrolled into view before checking boundingBox/moving mouse
      if (typeof el !== 'string' && typeof el.scrollIntoViewIfNeeded === 'function') {
        await el.scrollIntoViewIfNeeded().catch(() => {});
      }
      let box;
      if (typeof el === 'string') {
        const handle = await this.page.$(el);
        if (handle) {
          await handle.scrollIntoViewIfNeeded().catch(() => {});
          box = await handle.boundingBox();
        }
      } else {
        box = await el.boundingBox();
      }
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // Direct coordinates sync to prevent cursor lock on frame boundaries
        await this.page.evaluate(([x, y]) => {
          const cursor = document.getElementById('__agent-cursor');
          if (cursor) {
            cursor.style.left = x + 'px';
            cursor.style.top  = y + 'px';
          }
        }, [cx, cy]).catch(() => {});

        // Move in steps so the cursor visually travels across the screen
        await this.page.mouse.move(cx, cy, { steps: 12 });
        await this.page.waitForTimeout(250);
      }
    } catch { /* non-critical */ }
  }

  /**
   * Briefly highlight a target element with a glowing outline.
   * Automatically injects styling inside frames if the element is nested.
   * @param {import('playwright').Locator|string} el
   */
  async highlightElement(el) {
    if (!this.page || this._headless) return;
    try {
      const injectAndHighlight = (node) => {
        let style = document.getElementById('__agent-highlight-style');
        if (!style) {
          style = document.createElement('style');
          style.id = '__agent-highlight-style';
          style.textContent = `
            @keyframes __agent-highlight-pulse {
              0%   { box-shadow: 0 0 0 0 rgba(124,58,237,0.6); }
              50%  { box-shadow: 0 0 0 8px rgba(124,58,237,0.2); }
              100% { box-shadow: 0 0 0 0 rgba(124,58,237,0); }
            }
            .__agent-highlight {
              outline: 3px solid rgba(124,58,237,0.8) !important;
              outline-offset: 2px !important;
              animation: __agent-highlight-pulse 1s ease-in-out !important;
            }
          `;
          document.head.appendChild(style);
        }
        node.classList.add('__agent-highlight');
        setTimeout(() => node.classList.remove('__agent-highlight'), 1200);
      };

      if (typeof el === 'string') {
        await this.page.evaluate((sel, fnStr) => {
          const fn = new Function(`return ${fnStr}`)();
          const node = document.querySelector(sel);
          if (node) fn(node);
        }, el, injectAndHighlight.toString());
      } else {
        await el.evaluate(injectAndHighlight);
      }
      await this.page.waitForTimeout(400);
    } catch { /* non-critical */ }
  }

  /**
   * Navigate to a URL and wait for the page to load.
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async navigateToUrl(url) {
    if (!this.page) {
      this._log('error', '❌  Cannot navigate — browser page is not available');
      return false;
    }
    this._log('info', `🔗  Navigating to: ${url}`);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Wait for network idle but don't fail if it times out
      await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
        this._log('warning', '⚠  Network idle timeout — page may still be loading');
      });
      const title = await this.page.title().catch(() => '(unknown)');
      this._log('info', `✅  Page loaded: ${title}`);

      // Inject the visual cursor into the loaded page
      await this.injectVisualCursor();

      return true;
    } catch (err) {
      this._log('error', `❌  Navigation failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Capture a viewport screenshot and save it to the screenshots directory.
   * @param {string} label - Label for the screenshot filename
   * @returns {Promise<string>} Absolute path to the saved screenshot
   */
  async takeScreenshot(label = '') {
    if (!this.page) {
      this._log('warning', '⚠  Cannot take screenshot — browser page is not available');
      return '(no screenshot — page unavailable)';
    }
    try {
      this._count++;
      const name = `${String(this._count).padStart(3, '0')}_${label || 'screenshot'}.png`;
      const fp   = path.join(this._dir, name);
      await this.page.screenshot({ path: fp, fullPage: false });
      this._log('info', `📸  Screenshot: ${name}`);
      return fp;
    } catch (err) {
      this._log('warning', `⚠  Screenshot failed: ${err.message}`);
      return `(screenshot failed: ${err.message})`;
    }
  }
}

// ─────────────────────────────────────────────
// Main Agent Function (exported)
// ─────────────────────────────────────────────

/**
 * Run the automation agent with the given configuration.
 *
 * @param {Object} config
 * @param {string} config.instruction - Natural language instruction
 * @param {boolean} [config.headless=false] - Run browser in headless mode
 * @param {string} [config.aiProvider='none'] - AI provider: 'none'|'gemini'|'openrouter'|'grok'
 * @param {Object} [config.apiKeys={}] - API keys for the selected provider
 * @param {Function} [onLog] - Callback for real-time log streaming (level, msg)
 * @returns {Promise<Array>} Array of action log entries
 */
async function runAgent(config = {}, onLog) {
  const {
    instruction = '',
    headless    = process.env.HEADLESS === 'true' || process.env.CI === 'true' || false,
    aiProvider  = 'none',
    apiKeys     = {},
    runId: configRunId = null,
  } = config;

  // Resolve API keys from config or environment variables
  const keys = {
    gemini:     apiKeys.gemini     || process.env.GEMINI_API_KEY,
    openrouter: apiKeys.openrouter || process.env.OPENROUTER_API_KEY,
    grok:       apiKeys.grok       || process.env.GROK_API_KEY || process.env.XAI_API_KEY,
  };

  // Determine active provider (fall back to env vars if 'none' was selected)
  let provider = aiProvider;
  if (provider === 'none') {
    if (keys.gemini) provider = 'gemini';
    else if (keys.openrouter) provider = 'openrouter';
    else if (keys.grok) provider = 'grok';
  }

  // Logger setup
  let stream;
  try {
    const logFile = path.join(LOG_DIR, `agent_${Date.now()}.log`);
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (err) {
    console.error(`Failed to create log file: ${err.message}`);
    stream = { write: () => {}, end: () => {} }; // no-op fallback
  }

  const isModule = typeof onLog === 'function';
  const log = (level, msg) => {
    try { stream.write(`[${level.toUpperCase()}] ${msg}\n`); } catch { /* ignore write errors */ }
    if (isModule) {
      try { onLog(level, msg); } catch { /* ignore callback errors */ }
    } else {
      console.log(`${new Date().toISOString().slice(11, 23)} [${level.toUpperCase()}] ${msg}`);
    }
  };

  const runId = configRunId || String(Date.now());
  const runScreenshotDir = path.join(SCREENSHOT_DIR, `run_${runId}`);

  // Create run-specific directory
  try {
    fs.mkdirSync(runScreenshotDir, { recursive: true });
  } catch (err) {
    log('warning', `⚠  Failed to create run screenshot directory: ${err.message}`);
  }

  // Gracefully clean up old run directories
  try {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      const dirs = fs.readdirSync(SCREENSHOT_DIR);
      for (const d of dirs) {
        if (d !== `run_${runId}`) {
          try {
            fs.rmSync(path.join(SCREENSHOT_DIR, d), { recursive: true, force: true });
          } catch (e) {
            // ignore error if locked/in use
          }
        }
      }
    }
  } catch (err) {
    log('warning', `⚠  Failed to clean old run directories: ${err.message}`);
  }

  const tools     = new BrowserTools(runScreenshotDir, log);
  const ai        = new AIClient(provider, keys, log);
  const actionLog = [];

  const record = (action, detail = '', success = true) => {
    actionLog.push({ timestamp: new Date().toISOString(), action, detail, success });
    log(success ? 'info' : 'error', `${success ? '✅' : '❌'}  [${action}] ${detail}`);
  };

  log('info', '='.repeat(60));
  log('info', '  Website Automation Agent – Starting');
  log('info', '='.repeat(60));

  // Validate instruction
  if (!instruction || !instruction.trim()) {
    log('error', '❌  No instruction provided. Please provide a natural language instruction.');
    stream.end();
    return actionLog;
  }

  try {
    // 1. Parse instruction → execution plan
    const plan = await parseInstruction(instruction, ai, log);

    if (!plan.url) {
      throw new Error(
        'Could not find a URL in your instruction. ' +
        'Please include a URL (e.g. https://example.com) or a service name (e.g. "open youtube").'
      );
    }

    // 2. Open browser
    const browserOk = await tools.openBrowser(headless);
    if (!browserOk) throw new Error('Failed to launch browser. Is Playwright installed? Run: npx playwright install chromium');
    record('open_browser', 'Chromium launched');

    // 3. Navigate to URL
    const navOk = await tools.navigateToUrl(plan.url);
    record('navigate_to_url', plan.url, navOk);
    if (!navOk) throw new Error(`Navigation to ${plan.url} failed. Check the URL and your internet connection.`);

    // 4. Initial screenshot
    record('take_screenshot', await tools.takeScreenshot('initial_page'));

    // 5. Execute each action from the plan
    log('info', `\n▶  Executing ${plan.actions.length} action(s) …`);
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      const label  = `${action.type}${action.target ? ':' + action.target : ''}${action.value ? '→' + action.value : ''}${action.query ? ':' + action.query : ''}`;
      log('info', `\n── Action ${i + 1}/${plan.actions.length}: ${label}`);

      const ok = await executeAction(action, tools, log);
      record(action.type, label, ok);

      if (tools.page) {
        try {
          const stepLabel = `step_${String(i + 1).padStart(3, '0')}_${action.type}`;
          const screenshotPath = await tools.takeScreenshot(stepLabel);
          record('take_screenshot', screenshotPath);
        } catch (sErr) {
          log('warning', `⚠  In-between screenshot failed: ${sErr.message}`);
        }
      }
    }

    // 6. Final screenshot (at current scroll position to show changes)
    if (tools.page) {
      try { await tools.page.waitForTimeout(300); } catch { /* page may be closed */ }
    }
    record('take_screenshot', await tools.takeScreenshot('final_state'));
    log('info', '\n🎉  All actions completed!');

  } catch (err) {
    record('error', err.message, false);
    log('error', `Agent error: ${err.stack || err.message}`);
  } finally {
    // Visual mode: leave the browser context open for inspection
    if (!headless && tools.page) {
      log('info', '⏳  Leaving the browser open for inspection.');
      if (require.main === module) {
        log('info', 'Press Ctrl+C to exit and close the browser.');
        await new Promise(r => {}); // keep CLI process alive
      } else {
        await new Promise(r => setTimeout(r, 1000));
      }
    } else {
      await tools.closeBrowser();
    }

    // Summary
    log('info', '\n' + '='.repeat(60));
    log('info', '  EXECUTION SUMMARY');
    log('info', '='.repeat(60));
    actionLog.forEach((e, i) => {
      const pad = e.action.padEnd(20);
      log('info', `  ${String(i + 1).padStart(2, '0')}. ${e.success ? '✅' : '❌'} ${pad} ${e.detail}`);
    });
    const ok = actionLog.filter(e => e.success).length;
    log('info', `\n  Result: ${ok}/${actionLog.length} steps succeeded`);
    log('info', '='.repeat(60));

    // Write summary JSON
    try {
      fs.writeFileSync(path.join(LOG_DIR, 'summary.json'), JSON.stringify(actionLog, null, 2));
    } catch (err) {
      log('warning', `⚠  Failed to write summary.json: ${err.message}`);
    }

    try { stream.end(); } catch { /* ignore */ }
  }

  return actionLog;
}

// ─────────────────────────────────────────────
// Standalone entry point
// ─────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const isHeadless = args.includes('--headless') || process.env.HEADLESS === 'true' || process.env.CI === 'true';
  const cleanArgs = args.filter(a => a !== '--headless');
  const instruction = cleanArgs.join(' ') ||
    'Open https://ui.shadcn.com/docs/forms/react-hook-form and fill the name field with "John Doe" and fill the bio with "This is an automated submission"';

  console.log(`\nRunning: "${instruction}" [Headless: ${isHeadless}]\n`);
  runAgent({ instruction, headless: isHeadless }).catch(err => {
    console.error(`\n❌  Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runAgent, parseInstruction, parseInstructionRegex };
