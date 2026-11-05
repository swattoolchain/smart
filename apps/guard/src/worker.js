/**
 * Worker mode: this machine runs checks for the main server. Same image as the server, started with
 *   MAIN_URL=https://tharam.store JOIN_TOKEN=tjr_… node src/worker.js
 * The join token (from the founder console → Runners) is used once; the credentials it gives are saved in
 * DATA_DIR/runner.json and used from then on. The worker never needs the database, secrets or Shopify tokens:
 * the main server sends everything a check needs and gets the result and screenshots back.
 *
 * Every POLL_MS it checks in (that is also its heartbeat): it gets new checks and the ones to stop.
 * Settings: MAIN_URL, JOIN_TOKEN (first start), DATA_DIR, WORKER_POLL_MS (default 2000), CHROME_PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { runScan } from './engine/index.js';

const MAIN = String(process.env.MAIN_URL || '').replace(/\/$/, '');
const POLL_MS = Number(process.env.WORKER_POLL_MS || 2000);
const TYPE = 'application/vnd.tharam.runner+json';
const CREDS = path.join(config.dataDir, 'runner.json');
const LIMIT_MS = 6 * 60 * 1000;

if (!/^https?:\/\//.test(MAIN)) { console.error('Set MAIN_URL to the main server, e.g. https://tharam.store'); process.exit(1); }
if (MAIN.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(MAIN)) { console.error('MAIN_URL must use https (store passwords travel with each check).'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
fs.mkdirSync(config.dataDir, { recursive: true });

async function call(method, url, body, { auth, type = TYPE } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Runner ${auth}`;
  if (body !== undefined) headers['content-type'] = type;
  const r = await fetch(MAIN + url, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function credentials() {
  try { return JSON.parse(fs.readFileSync(CREDS, 'utf8')).credentials; } catch {}
  const token = process.env.JOIN_TOKEN;
  if (!token) { console.error('First start: set JOIN_TOKEN (create one in the founder console → Runners).'); process.exit(1); }
  const r = await call('POST', '/api/runner/join', { token });
  if (r.status !== 201) { console.error(`Could not join: ${r.json?.error || r.status}`); process.exit(1); }
  fs.writeFileSync(CREDS, JSON.stringify({ credentials: r.json.credentials, name: r.json.name, main: MAIN }), { mode: 0o600 });
  log(`joined as "${r.json.name}" with ${r.json.slots} slots`);
  return r.json.credentials;
}

const running = new Map(); // runId -> { controller, progress }

async function runOne(auth, spec) {
  const controller = new AbortController();
  const progress = { phase: 'open', rec: null };
  running.set(spec.runId, { controller, progress });
  let timer;
  let out;
  try {
    const limit = new Promise((_, rej) => (timer = setTimeout(() => { controller.abort(); rej(new Error('The test took longer than 6 minutes, so we stopped it. Your store may be very slow right now.')); }, LIMIT_MS)));
    const result = await Promise.race([runScan({ ...spec, signal: controller.signal, progress }), limit]);
    if (controller.signal.aborted) throw new Error('cancelled');
    // Screenshots first, then the result that points at them.
    const dir = path.join(config.dataDir, 'shots', `run-${spec.runId}`);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.png')) : []) {
      const r = await call('POST', `/api/runner/runs/${spec.runId}/shots/${encodeURIComponent(f)}`, fs.readFileSync(path.join(dir, f)), { auth, type: 'image/png' });
      if (r.status === 409) throw new Error('cancelled');
    }
    out = { result };
  } catch (e) {
    out = { error: controller.signal.aborted && e.message === 'cancelled' ? 'cancelled' : String(e.message || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
  try {
    const r = await call('POST', `/api/runner/runs/${spec.runId}/complete`, out, { auth });
    log(`check ${spec.runId}: ${out.error ? `error (${out.error})` : out.result.verdict}${r.status === 200 ? '' : ` — not accepted (${r.json?.error || r.status})`}`);
  } catch (e) { log(`check ${spec.runId}: could not send the result`, e.message); }
  running.delete(spec.runId);
  fs.rmSync(path.join(config.dataDir, 'shots', `run-${spec.runId}`), { recursive: true, force: true });
}

async function main() {
  const auth = await credentials();
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; log('stopping after current checks'); });
  while (!stopping || running.size) {
    try {
      const progress = Object.fromEntries([...running].map(([id, x]) => [id, { phase: x.progress.phase, checks: (x.progress.rec?.checks || []).map((c) => ({ id: c.id, title: c.title, status: c.status, severity: c.severity })), steps: (x.progress.rec?.steps || []).slice(-40) }]));
      const r = await call('POST', '/api/runner/check-in', { running: [...running.keys()], progress }, { auth });
      if (r.status === 401) { console.error('The main server no longer knows this runner. Delete runner.json and join again with a new token.'); process.exit(1); }
      if (r.status === 200) {
        for (const id of r.json.cancel || []) running.get(id)?.controller.abort();
        for (const spec of stopping ? [] : r.json.jobs || []) runOne(auth, spec);
      }
    } catch (e) { log('check-in failed', e.message); }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  process.exit(0);
}

main();
