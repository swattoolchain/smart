/**
 * AI review: a careful human reviewer for screenshots and product copy.
 * Works with Anthropic (default) or any OpenAI-compatible API. Every answer is cached by content hash,
 * so unchanged screenshots and product texts are never paid for twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const provider = () => config.ai.provider;
export const aiEnabled = () => !!config.ai.key;
export const aiVisionEnabled = () => aiEnabled() && (provider() === 'anthropic' || config.ai.visionCapable);

const cacheDir = () => path.join(config.dataDir, 'ai-cache');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 32);

function cached(key, fn) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = path.join(cacheDir(), `${key}.json`);
  if (fs.existsSync(file)) return Promise.resolve({ ...JSON.parse(fs.readFileSync(file, 'utf8')), cached: true });
  return fn().then((out) => {
    fs.writeFileSync(file, JSON.stringify(out));
    return out;
  });
}

function extractJson(text) {
  const t = String(text || '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI returned no JSON');
  return JSON.parse(t.slice(start, end + 1));
}

async function call({ system, text, images = [], model, maxTokens = 1500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    if (provider() === 'anthropic') {
      const content = [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(img.path).toString('base64') } })),
        ...images.map((img, i) => (img.label ? { type: 'text', text: `Image ${i + 1}: ${img.label}` } : null)).filter(Boolean),
        { type: 'text', text },
      ];
      const r = await fetch(`${config.ai.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': config.ai.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `AI request failed (${r.status})`);
      return { json: extractJson(j.content?.map((c) => c.text || '').join('')), usage: j.usage };
    }
    const content = [
      ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${fs.readFileSync(img.path).toString('base64')}` } })),
      { type: 'text', text: images.map((img, i) => (img.label ? `Image ${i + 1}: ${img.label}\n` : '')).join('') + text },
    ];
    const r = await fetch(`${config.ai.baseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.key}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? content : text }], response_format: { type: 'json_object' } }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `AI request failed (${r.status})`);
    return { json: extractJson(j.choices?.[0]?.message?.content), usage: j.usage };
  } finally {
    clearTimeout(timer);
  }
}

const SEVERITIES = new Set(['critical', 'major', 'minor']);
const clean = (findings) =>
  (Array.isArray(findings) ? findings : [])
    .filter((f) => f && f.issue)
    .slice(0, 12)
    .map((f) => ({ severity: SEVERITIES.has(f.severity) ? f.severity : 'minor', issue: String(f.issue).slice(0, 300), where: String(f.where || '').slice(0, 160), fix: String(f.fix || '').slice(0, 300) }));

const VISUAL_SYSTEM = `You are a meticulous e-commerce QA tester reviewing a screenshot of an online store, exactly as a careful shopper would see it.
Report only real problems a shopper would notice or that would cost a sale. Do not comment on design taste, brand choices, or things that are fine.
Look for: text that overlaps, is cut off or unreadable; broken or missing images (empty boxes, alt text showing); popups, banners or chat widgets covering important content or the buy button; layout that is misaligned, overflowing the screen or squashed; prices that look wrong (0, missing, mismatched currency, sale price higher than original); placeholder or template text (lorem ipsum, {{ }}, undefined, TBD); obvious spelling mistakes in visible headings and buttons; empty sections; buttons that look disabled or hidden.
Answer with JSON only: {"summary": "one sentence overall verdict", "findings": [{"severity": "critical|major|minor", "issue": "what is wrong, in plain words", "where": "where on the page", "fix": "how to fix it"}]}. Use an empty findings array if nothing is wrong. Critical means a shopper cannot buy or is seriously misled.`;

/** Reviews one screenshot. Cached by image hash, so unchanged screenshots cost nothing. */
export async function reviewScreenshot(file, { page, device, url }) {
  const buf = fs.readFileSync(file);
  const key = 'vis-' + sha(Buffer.concat([buf, Buffer.from(config.ai.visionModel)]));
  return cached(key, async () => {
    const { json, usage } = await call({
      system: VISUAL_SYSTEM,
      text: `This is the ${page} of ${url}, on a ${device} screen. Review it.`,
      images: [{ path: file }],
      model: config.ai.visionModel,
    });
    return { summary: String(json.summary || '').slice(0, 300), findings: clean(json.findings), usage, model: config.ai.visionModel };
  });
}

const DIFF_SYSTEM = `You compare two screenshots of the same online store page taken at different times: image 1 is BEFORE, image 2 is AFTER.
Describe what changed in plain words a store owner understands (for example "A red Diwali sale banner was added at the top", "The Add to cart button moved below the fold on mobile"). Then judge each change: "intended" if it looks like a deliberate edit, "suspicious" if it looks like a bug or accident (broken layout, missing images, overlapping elements, price problems).
Ignore tiny rendering differences, rotating carousels, and dynamic content like countdown timers.
Answer with JSON only: {"summary": "one sentence", "changes": [{"change": "what changed", "verdict": "intended|suspicious", "why": "short reason"}]}. Use an empty changes array if nothing meaningful changed.`;

/** Explains the difference between two screenshots (on demand from a report). */
export async function explainDiff(beforeFile, afterFile, { page, device }) {
  const key = 'diff-' + sha(Buffer.concat([fs.readFileSync(beforeFile), fs.readFileSync(afterFile), Buffer.from(config.ai.explainModel)]));
  return cached(key, async () => {
    const { json, usage } = await call({
      system: DIFF_SYSTEM,
      text: `Both images are the ${page} on a ${device} screen. Image 1 is before, image 2 is after.`,
      images: [{ path: beforeFile, label: 'BEFORE' }, { path: afterFile, label: 'AFTER' }],
      model: config.ai.explainModel,
    });
    const changes = (Array.isArray(json.changes) ? json.changes : []).slice(0, 10).map((c) => ({ change: String(c.change || '').slice(0, 300), verdict: c.verdict === 'suspicious' ? 'suspicious' : 'intended', why: String(c.why || '').slice(0, 200) }));
    return { summary: String(json.summary || '').slice(0, 300), changes, usage, model: config.ai.explainModel };
  });
}

const COPY_SYSTEM = `You are a meticulous e-commerce copy editor checking product titles and descriptions before customers see them.
Report only real mistakes: spelling errors, wrong words, grammar that changes meaning or looks careless, leftover placeholder text, missing or broken sentences, and facts that contradict each other within the same product (for example the title says "silk" but the description says "100% cotton", or two different sizes or weights).
Do NOT flag: brand names, product names, Indian and other non-English product terms written in English letters (kurta, saree, dupatta, ghee, masala, etc.), deliberate stylistic choices, British vs American spelling, or marketing tone.
Answer with JSON only: {"products": [{"handle": "the handle given", "issues": [{"severity": "major|minor", "issue": "what is wrong", "snippet": "the exact wrong text", "fix": "the corrected text"}]}]}. Leave out products that have no issues.`;

/** Reviews product copy in small batches. Each product is cached by its text hash, so only new or edited products are sent. */
export async function reviewCopy(products, { maxProducts = 60 } = {}) {
  const results = new Map();
  const pending = [];
  for (const p of products) {
    const key = 'copy-' + sha(`${config.ai.textModel}|${p.title}|${p.text}`);
    const file = path.join(cacheDir(), `${key}.json`);
    if (fs.existsSync(file)) results.set(p.handle, { ...JSON.parse(fs.readFileSync(file, 'utf8')), cached: true });
    else pending.push({ p, key, file });
  }
  fs.mkdirSync(cacheDir(), { recursive: true });
  const todo = pending.slice(0, maxProducts);
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12);
    const text = batch.map(({ p }) => `--- handle: ${p.handle}\nTitle: ${p.title}\nDescription: ${p.text.slice(0, 1800)}`).join('\n\n');
    const { json } = await call({ system: COPY_SYSTEM, text, model: config.ai.textModel, maxTokens: 2500 });
    const byHandle = new Map((json.products || []).map((x) => [x.handle, x]));
    for (const { p, file } of batch) {
      const issues = (byHandle.get(p.handle)?.issues || []).slice(0, 8).map((x) => ({
        severity: x.severity === 'major' ? 'major' : 'minor', issue: String(x.issue || '').slice(0, 300), snippet: String(x.snippet || '').slice(0, 160), fix: String(x.fix || '').slice(0, 200),
      })).filter((x) => x.issue);
      const out = { issues };
      fs.writeFileSync(file, JSON.stringify(out));
      results.set(p.handle, out);
    }
  }
  return { results, reviewed: todo.length, skipped: pending.length - todo.length };
}

const DRAFT_SYSTEM = `You turn a store owner's description of a test into steps for Tharam's test runner. Tharam shops an online store like a customer, in a real browser, and never pays.
You get the description and an outline of one page of the store (its address, headings, form fields, buttons and links, with their CSS ids, names and visible text).
Write ONE test using ONLY these steps (each step is an object with exactly one step key, plus the extra fields listed):
- {"open": "/path"} a page of the store; "{product}" is the test product's page
- {"click": TARGET}
- {"fill": TARGET, "value": "text to type"}
- {"choose": TARGET, "option": "visible option text"}
- {"quantity": 2}
- {"add_to_cart": true}, {"open_cart": true}, {"checkout": true} (stops before payment)
- {"wait_for": TARGET, "timeout": seconds up to 30}
- {"expect_visible": TARGET}, {"expect_hidden": TARGET}
- {"expect_text": TARGET, "contains": "text"}
- {"expect_price": TARGET, "min": n, "max": n} or "equals": n
- {"expect_count": TARGET, "min": n} or "equals"/"max"
- {"expect_url": "text in the address"}
- {"expect_cart_total": {"min": n, "max": n}}, {"expect_cart_items": {"min": 1}}
- {"expect_no_errors": true}
TARGET is a CSS selector from the outline ("#pincode"), visible text ("text=Check") or a role and name ("role=button:Check"). Prefer ids and names from the outline; never invent selectors that are not in the outline.
Start with an "open" step. End with at least one expect_ step that proves the feature worked. At most 15 steps. Never sign in, enter payment details or submit real orders, reviews or messages.
Answer with JSON only: {"name": "short test name, max 60 characters", "severity": "critical|major|minor", "device": "desktop|mobile", "steps": [ ... ], "note": "one plain sentence for the owner about anything to check in the draft"}.
If the description can't be done with these steps on this store, answer {"name": "", "steps": [], "note": "why, in one plain sentence"}.`;

/** Drafts one test (Your tests) from the owner's words and an outline of a store page. Cached by its inputs. */
export async function draftTest({ description, outline }) {
  const key = 'draft-' + sha(`${config.ai.textModel}|${description}|${outline}`);
  return cached(key, async () => {
    const { json, usage } = await call({ system: DRAFT_SYSTEM, text: `The owner's description:\n${description}\n\nThe page outline:\n${outline}`, model: config.ai.textModel, maxTokens: 2000 });
    return { draft: json && typeof json === 'object' ? json : {}, usage, model: config.ai.textModel };
  });
}
