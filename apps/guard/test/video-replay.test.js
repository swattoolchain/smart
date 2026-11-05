// Video replay of failed shopping journeys (roadmap 7): a per-store setting; failing journeys are recorded,
// the video is kept 7 days and only the store owner can open it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, startMock, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

describe('Video replay of failed journeys', { concurrency: 1 }, () => {
  let P, owner, other, storeId, healthy, healthyStoreId, browser, failedRun;
  before(async () => {
    P = await startProduct({ mock: { breaks: 'atc' } });
    healthy = await startMock();
    owner = await signup(P, 'video@shop.test');
    other = await signup(P, 'other-video@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    const r = await owner.post('/api/stores', { url: healthy.origin, name: 'Healthy Store', alertEmail: owner.email, runNow: false });
    assert.equal(r.status, 200, r.text);
    healthyStoreId = r.json.store?.id ?? r.json.id ?? r.json.storeId;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); healthy?.stop(); await P.stop(); });

  const store = async (id) => (await owner.get('/api/stores')).json.stores?.find((s) => s.id === id) ?? (await owner.get(`/api/stores/${id}`)).json;
  const videoFile = (runId) => path.join(P.dataDir, 'shots', `run-${runId}`, 'journey-video.webm');

  it('is off by default and the owner can switch it on per store', async (t) => {
    assert.equal((await store(storeId)).config.failureVideo, false);
    let r = await owner.patch(`/api/stores/${storeId}`, { config: { failureVideo: 'yes' } });
    assert.equal((await store(storeId)).config.failureVideo, false, 'only true/false is accepted');
    r = await owner.patch(`/api/stores/${storeId}`, { config: { failureVideo: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await store(storeId)).config.failureVideo, true);
    assert.equal((await store(healthyStoreId)).config.failureVideo, false, 'other stores unchanged');
    r = await other.patch(`/api/stores/${storeId}`, { config: { failureVideo: false } });
    assert.notEqual(r.status, 200, 'another account cannot change it');
    assert.equal((await store(storeId)).config.failureVideo, true);
    note(t, 'default off; switched on for one store only; strings ignored; other accounts refused');
  });

  it('a failing journey keeps a video, linked from the failed checks', { timeout: 300000 }, async (t) => {
    failedRun = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(failedRun.status, 'done', failedRun.error || '');
    const atc = failedRun.result.checks.find((c) => c.id === 'fn.atc');
    assert.equal(atc.status, 'fail');
    assert.equal(atc.evidence.video, `/shots/run-${failedRun.id}/journey-video.webm`);
    const days = (new Date(atc.evidence.videoUntil) - Date.now()) / 86400e3;
    assert.ok(days > 6.9 && days <= 7, `kept 7 days (${days.toFixed(2)})`);
    assert.ok(failedRun.result.video.checks.includes('fn.atc'));
    assert.ok(!failedRun.result.checks.find((c) => c.id === 'fn.home').evidence?.video, 'passing checks carry no video');
    const size = fs.statSync(videoFile(failedRun.id)).size;
    assert.ok(size > 1000, `video has content (${size} bytes)`);
    assert.ok(failedRun.result.cover, 'the report still has a cover screenshot');
    assert.ok(!fs.readdirSync(P.dataDir).some((d) => d.startsWith('video-tmp-')), 'no recording left behind');
    note(t, `fn.atc failed; video ${size} bytes kept until ${atc.evidence.videoUntil}`);
  });

  it('only the store owner can open the video', async (t) => {
    const url = `/shots/run-${failedRun.id}/journey-video.webm`;
    const mine = await fetch(P.base + url, { headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(mine.status, 200);
    assert.match(mine.headers.get('content-type'), /video\/webm/);
    assert.equal((await fetch(P.base + url, { headers: { cookie: [...other.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } })).status, 404, 'other account');
    assert.equal((await fetch(P.base + url)).status, 404, 'signed out');
    assert.equal((await fetch(`${P.base}${url}?t=${'a'.repeat(32)}.${Math.floor(Date.now() / 1000) + 3600}`)).status, 404, 'forged signed link');
    assert.equal((await other.get(`/api/runs/${failedRun.id}`)).status, 404, 'the run itself is private');
    note(t, 'owner 200 (video/webm); other account, signed-out and forged link 404');
  });

  it('a journey that passes keeps no video', { timeout: 300000 }, async (t) => {
    await owner.patch(`/api/stores/${healthyStoreId}`, { config: { failureVideo: true } });
    const run = await runAndWait(owner, healthyStoreId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    assert.ok(!run.result.checks.some((c) => c.status === 'fail'), 'healthy store passes');
    assert.equal(run.result.video, null);
    assert.ok(!fs.existsSync(videoFile(run.id)));
    assert.ok(run.result.theme, 'theme still detected from the journey window');
    assert.ok(!fs.readdirSync(P.dataDir).some((d) => d.startsWith('video-tmp-')), 'recording deleted');
    note(t, `run #${run.id}: all journey checks pass, no video file, theme “${run.result.theme?.name}”`);
  });

  it('with the setting off, a failing journey records nothing', { timeout: 300000 }, async (t) => {
    await owner.patch(`/api/stores/${storeId}`, { config: { failureVideo: false } });
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.result.checks.find((c) => c.id === 'fn.atc').status, 'fail');
    assert.equal(run.result.checks.find((c) => c.id === 'fn.atc').evidence?.video, undefined);
    assert.ok(!fs.existsSync(videoFile(run.id)));
    await owner.patch(`/api/stores/${storeId}`, { config: { failureVideo: true } });
    note(t, `run #${run.id}: fn.atc failed, no video`);
  });

  it('the report plays the replay, and Store settings has the switch', { timeout: 90000 }, async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/runs/${failedRun.id}`);
    await p.waitForSelector('.video-replay summary', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await p.locator('.video-replay summary').first().click();
    const v = p.locator('.video-replay video').first();
    await v.scrollIntoViewIfNeeded();
    await p.waitForFunction(() => document.querySelector('.video-replay video')?.readyState >= 1, null, { timeout: 15000 });
    const meta = await v.evaluate((el) => ({ w: el.videoWidth, h: el.videoHeight, src: el.currentSrc }));
    assert.ok(meta.w > 0 && meta.h > 0, JSON.stringify(meta));
    await v.evaluate((el) => { el.currentTime = 2; });
    await p.waitForTimeout(800);
    await screenshot(t, p, 'Report: replay of the failed journey');

    await p.goto(`${P.base}/app#/s/${storeId}/settings`);
    await p.waitForSelector('#fv', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    assert.equal(await p.isChecked('#fv'), true);
    await p.locator('#fv').scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Store settings: video replay switch');
    assert.deepEqual(errors, []);
    note(t, `video ${meta.w}x${meta.h} loads in the report`);
    await ctx.close();
  });

  it('videos are deleted after 7 days', async (t) => {
    process.env.DATA_DIR = P.dataDir;
    const { pruneVideos } = await import('../src/video.js');
    const fresh = path.join(P.dataDir, 'shots', 'run-990001');
    const old = path.join(P.dataDir, 'shots', 'run-990002');
    for (const d of [fresh, old]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'journey-video.webm'), 'x'); fs.writeFileSync(path.join(d, '01-home.png'), 'x'); }
    const ago = (days) => new Date(Date.now() - days * 86400e3);
    fs.utimesSync(path.join(fresh, 'journey-video.webm'), ago(6), ago(6));
    fs.utimesSync(path.join(old, 'journey-video.webm'), ago(8), ago(8));
    const n = pruneVideos();
    assert.equal(n, 1);
    assert.ok(fs.existsSync(path.join(fresh, 'journey-video.webm')), '6-day-old video kept');
    assert.ok(!fs.existsSync(path.join(old, 'journey-video.webm')), '8-day-old video deleted');
    assert.ok(fs.existsSync(path.join(old, '01-home.png')), 'screenshots stay with their run');
    assert.ok(fs.existsSync(videoFile(failedRun.id)), "today's video kept");
    note(t, 'pruned 1 of 3 videos (8 days old); screenshots untouched');
  });
});
