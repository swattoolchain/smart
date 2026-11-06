// Deploy: Docker cleanup after a successful deploy (deploy/docker-cleanup.sh, called by deploy/deploy.sh).
// Runs the real scripts with a fake `docker` on PATH that only records what it was asked to do.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/harness.js';
import { note } from './lib/evidence.js';

const DEPLOY = path.resolve(ROOT, '..', '..', 'deploy');
const CLEANUP = path.join(DEPLOY, 'docker-cleanup.sh');

let bin, calls;
function fakeDocker({ fail = false } = {}) {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-fake-docker-'));
  calls = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${calls}"
if [ "$1" = "system" ]; then echo "Images: 3GB (2GB reclaimable)"; exit 0; fi
${fail ? 'exit 1' : 'echo "Total reclaimed space: 1.2GB"'}
`, { mode: 0o755 });
  return bin;
}
const recorded = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l && !l.startsWith('system')) : []);
const run = (script, env = {}, input = null) => spawnSync('bash', input ? ['-c', input] : [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf8' });

describe('Deploy: Docker cleanup', () => {
  before(() => {
    for (const f of ['deploy.sh', 'docker-cleanup.sh']) assert.equal(spawnSync('bash', ['-n', path.join(DEPLOY, f)]).status, 0, `${f} has valid syntax`);
  });

  it('removes dangling images and build cache older than 3 days, and nothing else', (t) => {
    fakeDocker();
    const r = run(CLEANUP);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(recorded(), ['image prune -f', 'builder prune -f --filter until=72h']);
    assert.doesNotMatch(fs.readFileSync(CLEANUP, 'utf8'), /prune -a|--all|volume prune|system prune|container prune|network prune/, 'never removes tagged images, volumes, containers or networks');
    assert.match(r.stdout, /Before:\nImages: 3GB/);
    note(t, r.stdout);
  });

  it('PRUNE=0 skips it; PRUNE_CACHE_HOURS changes how much cache is kept; bad hours are refused', () => {
    fakeDocker();
    let r = run(CLEANUP, { PRUNE: '0' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skipped/);
    assert.deepEqual(recorded(), []);
    r = run(CLEANUP, { PRUNE_CACHE_HOURS: '24' });
    assert.deepEqual(recorded(), ['image prune -f', 'builder prune -f --filter until=24h']);
    fakeDocker();
    r = run(CLEANUP, { PRUNE_CACHE_HOURS: '1; rm -rf /' });
    assert.equal(r.status, 1);
    assert.deepEqual(recorded(), []);
  });

  it('a failing prune never fails the deploy', () => {
    fakeDocker({ fail: true });
    const r = run(CLEANUP);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Could not remove dangling images \(continuing\)/);
    assert.match(r.stdout, /Could not clear old build cache \(continuing\)/);
  });

  // The end of deploy.sh, from the health wait to the cleanup, run as written with the app healthy or not.
  const tail = () => {
    const s = fs.readFileSync(path.join(DEPLOY, 'deploy.sh'), 'utf8');
    const a = s.indexOf('say "Waiting for the app"');
    const b = s.indexOf('\nfi\n', s.indexOf('if [ "$HEALTHY" = "1" ]')) + 4;
    assert.ok(a > 0 && b > a, 'health wait and cleanup found in deploy.sh');
    return s.slice(a, b);
  };
  function deployTail(healthy) {
    fakeDocker();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-deploy-'));
    fs.mkdirSync(path.join(dir, 'deploy'));
    fs.copyFileSync(CLEANUP, path.join(dir, 'deploy', 'docker-cleanup.sh'));
    fs.writeFileSync(path.join(bin, 'fakecompose'), `#!/usr/bin/env bash\nexit ${healthy ? 0 : 1}\n`, { mode: 0o755 });
    const script = `set -euo pipefail\nsay() { echo "$*"; }\nsleep() { :; }\nDIR=${JSON.stringify(dir)}\nCOMPOSE=fakecompose\n${tail()}`;
    return run(null, {}, script);
  }

  it('deploy.sh cleans up only after the new version answers', (t) => {
    const ok = deployTail(true);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /App is healthy\.\nCleaning up old Docker images and build cache/);
    assert.deepEqual(recorded(), ['image prune -f', 'builder prune -f --filter until=72h']);
    const bad = deployTail(false);
    assert.equal(bad.status, 0, bad.stderr);
    assert.match(bad.stdout, /did not answer yet, so old Docker images were kept/);
    assert.deepEqual(recorded(), [], 'nothing pruned after a failed deploy');
    note(t, `healthy:\n${ok.stdout}\nnot healthy:\n${bad.stdout}`);
  });
});
