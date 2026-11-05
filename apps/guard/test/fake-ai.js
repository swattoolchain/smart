// A stand-in for the AI provider (Anthropic Messages API), for tests of the AI shopper.
// It plays a simple, predictable shopper from the text it is sent: home -> product -> Add to cart -> cart -> checkout.
// Control: POST /control {mode: 'shop' | 'stuck' | 'naughty' | 'loop' | 'lured' | 'express'}; GET /state -> {calls, prompts}
import http from 'node:http';
const PORT = Number(process.env.FAKE_AI_PORT || 4300);
const state = { mode: 'shop', calls: 0, prompts: [], keys: [] };
const read = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const reply = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 100, output_tokens: 20 } })); };

function decide(text) {
  const path = /Address: (\S+)/.exec(text)?.[1] || '/';
  const cart = Number(/Items in cart: (\d+)/.exec(text)?.[1] ?? NaN);
  const items = [...text.matchAll(/^\[(\d+)\] (\w+) "([^"]*)"(?: -> (\S+))?/gm)].map((m) => ({ i: Number(m[1]), kind: m[2], text: m[3], href: m[4] || '' }));
  const did = text.split('The page now:')[0];
  const steps = (did.match(/^\d+\. /gm) || []).length;
  const find = (re, kind) => items.find((x) => (!kind || x.kind === kind) && re.test(x.text));
  if (state.mode === 'stuck') return { thought: 'I cannot find any products.', action: { type: 'stuck', reason: 'no products are shown on the homepage' }, friction: [{ severity: 'major', issue: 'The homepage shows no products' }] };
  if (state.mode === 'loop') { const home = find(/Mock Store/); return { thought: 'Going home again.', action: { type: 'click', index: home?.i ?? 0 }, friction: [] }; }
  if (state.mode === 'naughty' && steps === 0) return { thought: 'Leaving.', action: { type: 'goto', path: 'https://evil.example/steal' }, friction: [] };
  if (state.mode === 'naughty' && steps === 1) return { thought: 'Admin.', action: { type: 'goto', path: '/admin' }, friction: [] };
  if (state.mode === 'naughty' && steps === 2) return { thought: 'Nonsense.', action: { type: 'click', index: 999 }, friction: [] };
  // lured: page text steers it off the store, then it calls a store page about checkout "checkout".
  if (state.mode === 'lured' && steps === 0) { const l = find(/go to checkout/i, 'link'); const url = /go to (https?:\/\/\S+?)(?: |$)/i.exec(text)?.[1]; return { thought: 'The page says to go there.', action: l ? { type: 'click', index: l.i } : { type: 'goto', path: url || '/' }, friction: [] }; }
  if (state.mode === 'lured' && steps === 1) { const h = find(/checkout help/i, 'link'); return { thought: 'Checkout is here.', action: { type: 'click', index: h?.i ?? -1 }, friction: [] }; }
  if (state.mode === 'lured' && steps === 2) return { thought: 'This is checkout.', action: { type: 'done' }, friction: [] };
  if (state.mode === 'lured' && steps === 3) return { thought: 'Back to the homepage.', action: { type: 'goto', path: '/' }, friction: [] };
  if (/^\/check/.test(path)) return { thought: 'Checkout is open.', action: { type: 'done' }, friction: [] };
  if (path.startsWith('/cart')) {
    if (cart === 0) return { thought: 'The cart is empty.', action: { type: 'stuck', reason: 'the cart is empty although I pressed Add to cart' }, friction: [{ severity: 'critical', issue: 'Add to cart did not put the product in the cart' }] };
    const co = state.mode === 'express' ? find(/express checkout/i, 'button') : find(/^check ?out$/i, 'button');
    return { thought: 'Going to checkout.', action: { type: 'click', index: co?.i ?? -1 }, friction: [] };
  }
  if (path.startsWith('/products/')) {
    if (/clicked button "Add to cart"/.test(did) && cart === 0) return { thought: 'Nothing happened when I added it.', action: { type: 'stuck', reason: 'clicking Add to cart did nothing' }, friction: [{ severity: 'critical', issue: 'Clicking Add to cart did nothing' }] };
    if (cart > 0) { const c = find(/^Cart$/, 'link'); return { thought: 'Added. Opening the cart.', action: c ? { type: 'click', index: c.i } : { type: 'goto', path: '/cart' }, friction: [] }; }
    const add = find(/add to (cart|bag)/i, 'button');
    return { thought: 'Adding it to the cart.', action: { type: 'click', index: add?.i ?? -1 }, friction: add ? [] : [{ severity: 'major', issue: 'No Add to cart button' }] };
  }
  const p = items.find((x) => x.kind === 'link' && /\/products\//.test(x.href));
  return { thought: 'Opening a product.', action: p ? { type: 'click', index: p.i } : { type: 'stuck', reason: 'no product links' }, friction: [] };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const body = await read(req);
  if (u.pathname === '/control') { Object.assign(state, JSON.parse(body || '{}')); res.end('{}'); return; }
  if (u.pathname === '/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ calls: state.calls, prompts: state.prompts.slice(-30), keys: [...new Set(state.keys)] })); return; }
  if (u.pathname.endsWith('/v1/messages') && req.method === 'POST') {
    state.calls++;
    state.keys.push(req.headers['x-api-key']);
    const j = JSON.parse(body);
    const text = (j.messages?.[0]?.content || []).map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n') || String(j.messages?.[0]?.content || '');
    state.prompts.push({ system: j.system, text });
    return reply(res, decide(text));
  }
  res.writeHead(404); res.end('{}');
}).listen(PORT, () => console.log(`fake AI on ${PORT}`));
