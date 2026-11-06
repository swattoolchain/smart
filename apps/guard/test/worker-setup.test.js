// Worker VM setup (T66): deploy/worker.sh turns a fresh Ubuntu VM into a Tharam runner.
// Docker isn't available in tests, so the script runs in its dry-run mode (settings file only, commands printed),
// the compose file is checked for what the worker needs, and a real worker shows it writes the health file
// the container health check reads.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startProduct, startWorker, FOUNDER, ROOT } from './lib/harness.js';
import { note } from './lib/evidence.js';

const REPO = path.resolve(ROOT, '..', '..');
const SCRIPT = path.join(REPO, 'deploy', 'worker.sh');
const COMPOSE = path.join(REPO, 'deploy', 'docker-compose.worker.yml');

function setup(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-worker-setup-'));
  const r = spawnSync('bash', [SCRIPT], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), WORKER_SETUP_DRY_RUN: '1', DIR: dir, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ...r, dir, envFile: path.join(dir, 'deploy', 'worker.env') };
}

describe('Worker VM setup script', () => {
  it('is valid bash', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.statSync(SCRIPT).mode & 0o100, 'executable');
  });

  it('saves the main server address and join token (owner-only file), then builds and starts the worker', (t) => {
    const r = setup({ MAIN_URL: 'https://tharam.store/', JOIN_TOKEN: 'tjr_abcdefghijklmnopqrstuvwxyz012345' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const env = fs.readFileSync(r.envFile, 'utf8');
    assert.match(env, /^MAIN_URL=https:\/\/tharam\.store$/m, 'trailing slash removed');
    assert.match(env, /^JOIN_TOKEN=tjr_abcdefghijklmnopqrstuvwxyz012345$/m);
    assert.equal(fs.statSync(r.envFile).mode & 0o777, 0o600, 'only root can read it');
    assert.match(r.stdout, /would run: docker compose -p tharam-worker -f docker-compose.worker.yml up -d --build/);
    assert.match(r.stdout, /remove JOIN_TOKEN/);
    // Running it again (an update) asks nothing and keeps the settings.
    const again = spawnSync('bash', [SCRIPT], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), WORKER_SETUP_DRY_RUN: '1', DIR: r.dir }, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Using the saved settings/);
    assert.equal(fs.readFileSync(r.envFile, 'utf8'), env);
    fs.rmSync(r.dir, { recursive: true, force: true });
    note(t, 'worker.env written with mode 600; a second run reuses it without questions');
  });

  it('refuses a plain-http main server and a malformed join token, and saves nothing', () => {
    for (const [env, msg] of [
      [{ MAIN_URL: 'http://tharam.store', JOIN_TOKEN: 'tjr_abcdefghijklmnopqrstuvwxyz012345' }, /must start with https/],
      [{ MAIN_URL: 'https://tharam.store/x; rm -rf /', JOIN_TOKEN: 'tjr_abcdefghijklmnopqrstuvwxyz012345' }, /must start with https/],
      [{ MAIN_URL: 'https://tharam.store', JOIN_TOKEN: 'not-a-token' }, /doesn't look like a join token/],
      [{ MAIN_URL: 'https://tharam.store', JOIN_TOKEN: 'tjr_short' }, /doesn't look like a join token/],
      [{ MAIN_URL: 'https://tharam.store' }, /doesn't look like a join token/],
    ]) {
      const r = setup(env);
      assert.notEqual(r.status, 0, JSON.stringify(env));
      assert.match(r.stderr, msg);
      assert.ok(!fs.existsSync(r.envFile), 'nothing saved');
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('the compose file runs the worker from the same image, keeps its credentials, opens no ports and has a health check', () => {
    const y = fs.readFileSync(COMPOSE, 'utf8');
    assert.match(y, /build: \.\.\/apps\/guard/);
    assert.match(y, /command: \["node", "src\/worker\.js"\]/);
    assert.match(y, /env_file: worker\.env/);
    assert.match(y, /worker-data:\/data/);
    assert.match(y, /restart: unless-stopped/);
    assert.doesNotMatch(y, /ports:/);
    assert.match(y, /healthcheck:[\s\S]*worker-health\.json[\s\S]*60000/);
    assert.ok(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').includes('COPY src ./src'), 'worker.js ships in the image');
    const readme = fs.readFileSync(path.join(REPO, 'deploy', 'README.md'), 'utf8');
    for (const s of ['worker.sh', 'join token', 'Drain', 'Runners']) assert.ok(readme.includes(s), `README explains ${s}`);
  });
});

describe('Worker health file', () => {
  let P, w;
  before(async () => { P = await startProduct(); });
  after(async () => { w?.cleanup(); await P?.stop(); });

  it('a running worker records when the main server last answered; the health check command accepts it', async (t) => {
    const password = 'founder-test-password';
    const c = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, password, 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const founder = P.session();
    assert.equal((await founder.post('/api/auth/login', { email: FOUNDER, password })).status, 200);
    const tok = await founder.post('/api/admin/runners/join-tokens', { name: 'vm-1', slots: 1, tags: 'eu' });
    assert.equal(tok.status, 201, tok.text);
    w = await startWorker(P, tok.json.token);
    const file = path.join(w.dataDir, 'worker-health.json');
    const until = Date.now() + 10000;
    while (!fs.existsSync(file) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(h.name, 'vm-1');
    assert.equal(h.status, 'active');
    assert.ok(Date.now() - Date.parse(h.at) < 10000);
    // The exact command from the compose file's health check, pointed at this worker's data folder.
    const y = fs.readFileSync(COMPOSE, 'utf8');
    const js = /"-e", "(.+)"\]/.exec(y)[1].replace(/\\"/g, '"').replace('/data/worker-health.json', file);
    assert.equal(spawnSync(process.execPath, ['-e', js]).status, 0, 'healthy');
    w.kill();
    fs.writeFileSync(file, JSON.stringify({ ...h, at: new Date(Date.now() - 120000).toISOString() }));
    assert.equal(spawnSync(process.execPath, ['-e', js]).status, 1, 'unhealthy when the main server has not answered for 2 minutes');
    note(t, `worker-health.json: ${JSON.stringify(h)}`);
  });
});
