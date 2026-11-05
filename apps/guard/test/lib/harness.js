/**
 * Test harness: starts the whole product in isolation for one test file.
 *   - a mock Shopify storefront (test/mock-store.js)
 *   - fake Shopify Admin and Razorpay APIs (test/fake-services.js)
 *   - the Tharam server, on a free port, with a fresh temporary database
 * Nothing touches real services, the network, or the developer's data folder.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHOPIFY = { key: 'testkey', secret: 'testsecret' };
export const RZP = { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret', webhookSecret: 'rzp_webhook_secret' };
export const FOUNDER = 'founder@tharam.test';

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function launch(file, env) {
  const child = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, log: () => out, stop: () => { try { child.kill('SIGTERM'); } catch {} } };
}

/** A mock Shopify storefront. `breaks`: atc, search, checkout, jserror, password, cloudflare, discount, … */
export async function startMock({ breaks = '', extra = '', draftBreaks } = {}) {
  const port = await freePort();
  const env = { MOCK_PORT: String(port), MOCK_BREAK: breaks, MOCK_EXTRA: extra };
  if (draftBreaks !== undefined) env.MOCK_DRAFT_BREAK = draftBreaks;
  const p = launch('test/mock-store.js', env);
  const origin = `http://localhost:${port}`;
  await waitFor(`${origin}/products.json`);
  return { ...p, port, origin };
}

/** Fake Shopify Admin API + Razorpay API, with a /control endpoint to change their answers. */
export async function startFake() {
  const port = await freePort();
  const p = launch('test/fake-services.js', { FAKE_PORT: String(port) });
  const base = `http://localhost:${port}`;
  await waitFor(`${base}/state`);
  const control = async (body) => (await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify(body) })).json();
  const state = async () => (await fetch(`${base}/state`)).json();
  return { ...p, port, base, control, state };
}

/** The whole product. Call `stop()` in an `after` hook. */
export async function startProduct({ env = {}, mock: mockOpts = {} } = {}) {
  const mock = await startMock(mockOpts);
  const fake = await startFake();
  await fake.control({ primaryDomain: mock.origin, subscription: null });
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-test-'));
  const base = `http://localhost:${port}`;
  const server = launch('src/server.js', {
    NODE_ENV: 'test',
    PORT: String(port),
    BASE_URL: base,
    DATA_DIR: dataDir,
    SESSION_SECRET: crypto.randomBytes(16).toString('hex'),
    ALLOW_LOCAL_TARGETS: '1',
    DISABLE_SCHEDULER: '1',
    MAIL_DEBUG: '1',
    SMTP_HOST: '',
    ADMIN_EMAIL: FOUNDER,
    SHOPIFY_API_KEY: SHOPIFY.key,
    SHOPIFY_API_SECRET: SHOPIFY.secret,
    SHOPIFY_ADMIN_BASE: fake.base,
    RAZORPAY_KEY_ID: RZP.keyId,
    RAZORPAY_KEY_SECRET: RZP.keySecret,
    RAZORPAY_WEBHOOK_SECRET: RZP.webhookSecret,
    RAZORPAY_API_BASE: `${fake.base}/rzp`,
    AI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ...env,
  });
  try { await waitFor(`${base}/healthz`); } catch (e) { mock.stop(); fake.stop(); server.stop(); throw new Error(`${e.message}\n${server.log()}`); }
  let dbh;
  const product = {
    base, port, dataDir, mock, fake,
    log: server.log,
    /** Read-only view of the product's database, for assertions. */
    db: () => (dbh ||= new Database(path.join(dataDir, 'guard.db'), { readonly: true, fileMustExist: true })),
    session: (opts) => new Session(base, opts),
    stop: async () => {
      try { dbh?.close(); } catch {}
      server.stop(); mock.stop(); fake.stop();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return product;
}

/**
 * A worker machine (src/worker.js) joined to the product with a join token, with its own data folder.
 * `kill()` stops it the hard way (like a machine dying); `credentials()` reads what it got when it joined.
 */
export async function startWorker(product, token, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-worker-'));
  const w = launch('src/worker.js', { MAIN_URL: product.base, JOIN_TOKEN: token, DATA_DIR: dataDir, WORKER_POLL_MS: '500', ALLOW_LOCAL_TARGETS: '1', ...env });
  const until = Date.now() + 15000;
  while (!fs.existsSync(path.join(dataDir, 'runner.json'))) {
    if (Date.now() > until || w.child.exitCode != null) throw new Error(`worker did not join: ${w.log()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    ...w, dataDir,
    credentials: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'runner.json'), 'utf8')).credentials,
    kill: () => { try { w.child.kill('SIGKILL'); } catch {} },
    cleanup: () => { try { w.child.kill('SIGKILL'); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

/** A Shopify session token, as App Bridge would hand it to the embedded app. */
export function shopifyToken(shop, { secret = SHOPIFY.secret, aud = SHOPIFY.key, expIn = 60 } = {}) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b({ alg: 'HS256', typ: 'JWT' });
  const p = b({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud, sub: '42', exp: now + expIn, nbf: now - 5, iat: now, jti: crypto.randomUUID(), sid: 'test' });
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

/** Signs a Shopify webhook body the way Shopify does. */
export const shopifyHmac = (body, secret = SHOPIFY.secret) => crypto.createHmac('sha256', secret).update(body).digest('base64');

/**
 * One visitor of the product: keeps cookies like a browser, or sends a Shopify bearer token like
 * the embedded app (`shop` option).
 */
export class Session {
  constructor(base, { shop } = {}) { this.base = base; this.shop = shop; this.cookies = new Map(); }
  async req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.shop) h.authorization = `Bearer ${shopifyToken(this.shop)}`;
    let payload;
    if (body !== undefined) { h['content-type'] ||= 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const r = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) {
      const [nv] = c.split(';'); const i = nv.indexOf('=');
      const name = nv.slice(0, i), value = nv.slice(i + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  }
  get(u, h) { return this.req('GET', u, undefined, h); }
  post(u, b, h) { return this.req('POST', u, b ?? {}, h); }
  patch(u, b, h) { return this.req('PATCH', u, b ?? {}, h); }
  del(u, h) { return this.req('DELETE', u, undefined, h); }

  /** Cookies in Playwright's format, to open the app in a browser as this visitor. */
  browserCookies() {
    const host = new URL(this.base).hostname;
    return [...this.cookies].map(([name, value]) => ({ name, value, domain: host, path: '/' }));
  }
}

/** Creates a website account and returns its signed-in session. */
export async function signup(product, email = `owner-${crypto.randomUUID().slice(0, 8)}@shop.test`, password = 'correct horse battery') {
  const s = product.session();
  const r = await s.post('/api/auth/signup', { email, password, name: 'Test Owner' });
  if (r.status !== 200) throw new Error(`signup failed ${r.status} ${r.text}`);
  s.email = email; s.password = password;
  return s;
}

/** Opens the embedded Shopify app for a shop (installs it on first open) and returns its session. */
export async function shopifyOpen(product, shop = `shop-${crypto.randomUUID().slice(0, 6)}.myshopify.com`) {
  const s = product.session({ shop });
  const r = await s.post('/shopify/api/session', {});
  if (r.status !== 200) throw new Error(`shopify session failed ${r.status} ${r.text}`);
  s.storeId = r.json.storeId;
  return s;
}

/** Adds a store for a website account, pointing at the mock storefront. */
export async function addStore(product, s, extra = {}) {
  const r = await s.post('/api/stores', { url: product.mock.origin, name: 'Mock Store', alertEmail: s.email, ...extra });
  if (r.status !== 200) throw new Error(`add store failed ${r.status} ${r.text}`);
  return r.json.store?.id ?? r.json.id ?? r.json.storeId;
}

/** Starts a run and waits until it finishes. Returns the finished run. */
export async function runAndWait(s, storeId, body = {}, timeoutMs = 240000) {
  const r = await s.post(`/api/stores/${storeId}/run`, body);
  if (r.status !== 200) throw new Error(`run failed ${r.status} ${r.text}`);
  const id = r.json.runId;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const g = await s.get(`/api/runs/${id}`);
    if (g.json && ['done', 'error', 'cancelled'].includes(g.json.status)) return g.json;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`run ${id} did not finish in time`);
}

/** The most recent emailed link for an address, from the server's mail log (MAIL_DEBUG). */
export function lastMailLink(product, pattern = /https?:\/\/[^\s]+#\/signin\/[\w-]+/g) {
  const m = product.log().match(pattern);
  return m ? m.at(-1) : null;
}
