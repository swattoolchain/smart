/**
 * node:test reporter that writes the evidence report:
 *   test-results/report.html  every feature, every test, pass/fail, time, notes and screenshots
 *   test-results/summary.md   the short version (also shown on the GitHub Actions run page)
 *   test-results/results.json machine-readable
 * Usage: node --test --test-reporter=spec --test-reporter-destination=stdout \
 *                    --test-reporter=./test/lib/reporter.js --test-reporter-destination=test-results/reporter.log
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'test-results');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export default async function* reporter(source) {
  const tests = [];
  const stack = new Map(); // nesting -> name, to build full names
  for await (const ev of source) {
    if (ev.type === 'test:start') stack.set(ev.data.nesting, ev.data.name);
    if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const d = ev.data;
      // Only leaf tests and failed suites are rows; passing suites are just headings.
      const isSuite = d.details?.type === 'suite';
      const names = [];
      for (let i = 0; i < d.nesting; i++) if (stack.has(i)) names.push(stack.get(i));
      names.push(d.name);
      const file = d.file ? path.relative(ROOT, d.file) : '';
      if (!isSuite || ev.type === 'test:fail') {
        tests.push({
          file, feature: names.length > 1 ? names[0] : path.basename(file).replace(/\.test\.js$/, ''), name: names.slice(names.length > 1 ? 1 : 0).join(' › '), full: names.join(' > '),
          ok: ev.type === 'test:pass' && !d.skip, skipped: !!d.skip || !!d.todo, ms: Math.round(d.details?.duration_ms || 0),
          error: ev.type === 'test:fail' ? String(d.details?.error?.cause?.message || d.details?.error?.message || d.details?.error || '').slice(0, 2000) : '',
        });
      }
      yield '';
    }
  }

  // Evidence collected by the tests themselves.
  const ev = [];
  try { for (const line of fs.readFileSync(path.join(OUT, 'evidence', 'index.jsonl'), 'utf8').split('\n')) if (line) ev.push(JSON.parse(line)); } catch {}
  const evFor = (t) => ev.filter((e) => e.test === t.name.split(' › ').at(-1) || e.test === t.full || t.full.endsWith(e.test));

  const passed = tests.filter((t) => t.ok).length, failed = tests.filter((t) => !t.ok && !t.skipped).length, skipped = tests.filter((t) => t.skipped).length;
  const features = [...new Set(tests.map((t) => t.feature))];
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const commit = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : '';
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ when, commit, passed, failed, skipped, tests }, null, 2));

  const md = [`## Tharam test report ${failed ? '❌' : '✅'}`, '', `${passed} passed · ${failed} failed · ${skipped} skipped · ${when}${commit ? ` · ${commit}` : ''}`, '', '| Feature | Passed | Failed |', '| --- | --- | --- |',
    ...features.map((f) => { const ts = tests.filter((t) => t.feature === f); return `| ${f} | ${ts.filter((t) => t.ok).length} | ${ts.filter((t) => !t.ok && !t.skipped).length} |`; }),
    ...(failed ? ['', '### Failures', ...tests.filter((t) => !t.ok && !t.skipped).map((t) => `- **${t.feature}: ${t.name}**: ${t.error.split('\n')[0]}`)] : [])].join('\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), md + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');

  const row = (t) => {
    const e = evFor(t);
    const notes = e.filter((x) => x.kind === 'note').map((x) => `<li>${esc(x.text)}</li>`).join('');
    const shots = e.filter((x) => x.kind === 'shot').map((x) => `<figure><a href="evidence/${esc(x.file)}"><img src="evidence/${esc(x.file)}" alt="${esc(x.label)}" loading="lazy"></a><figcaption>${esc(x.label)}</figcaption></figure>`).join('');
    return `<li class="${t.ok ? 'ok' : t.skipped ? 'skip' : 'bad'}"><div class="t"><span class="mark">${t.ok ? 'Pass' : t.skipped ? 'Skip' : 'Fail'}</span><b>${esc(t.name)}</b><span class="ms">${t.ms} ms</span></div>
      ${t.error ? `<pre>${esc(t.error)}</pre>` : ''}${notes ? `<ul class="notes">${notes}</ul>` : ''}${shots ? `<div class="shots">${shots}</div>` : ''}</li>`;
  };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tharam test report</title>
<style>
:root{--ink:#1d2433;--muted:#5f6b80;--line:#e3e7ef;--ok:#1a8a4a;--bad:#c4262c;--skip:#8a90a2;--bg:#f6f7fb;--card:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#e8ebf2;--muted:#a3abbd;--line:#2c3346;--bg:#121521;--card:#1a1f2e}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 60px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.tot{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}.tot div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px}.tot b{font-size:22px;display:block}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:14px}h2{font-size:16px;margin:0 0 8px;display:flex;gap:10px;align-items:baseline}h2 small{color:var(--muted);font-weight:400}
ol{list-style:none;margin:0;padding:0}ol>li{padding:8px 0;border-top:1px solid var(--line)}ol>li:first-child{border-top:0}
.t{display:flex;gap:10px;align-items:baseline}.t b{font-weight:500;flex:1}.ms{color:var(--muted);font-size:12px}
.mark{font-size:11px;font-weight:700;padding:1px 7px;border-radius:5px;text-transform:uppercase}.ok .mark{background:#e5f4e9;color:var(--ok)}.bad .mark{background:#fbe9ea;color:var(--bad)}.skip .mark{background:#eef0f4;color:var(--skip)}
pre{white-space:pre-wrap;background:#fbe9ea;color:#7a1218;padding:8px 10px;border-radius:8px;font-size:12px;overflow:auto}
.notes{margin:6px 0 0 62px;color:var(--muted);font-size:13px;padding:0}.notes li{list-style:disc}
.shots{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 0 62px}figure{margin:0;width:240px}figure img{width:100%;border:1px solid var(--line);border-radius:8px}figcaption{font-size:12px;color:var(--muted)}
@media (max-width:600px){.notes,.shots{margin-left:0}figure{width:100%}}
</style></head><body><main>
<h1>Tharam test report</h1><p class="sub">${esc(when)}${commit ? ` · commit ${esc(commit)}` : ''}</p>
<div class="tot"><div><b style="color:var(--ok)">${passed}</b>passed</div><div><b style="color:var(--bad)">${failed}</b>failed</div><div><b>${skipped}</b>skipped</div><div><b>${features.length}</b>features</div></div>
${features.map((f) => { const ts = tests.filter((t) => t.feature === f); const bad = ts.filter((t) => !t.ok && !t.skipped).length; return `<section><h2>${esc(f)} <small>${ts.length - bad}/${ts.length} passed</small></h2><ol>${ts.map(row).join('')}</ol></section>`; }).join('')}
</main></body></html>`;
  fs.writeFileSync(path.join(OUT, 'report.html'), html);
  yield `Report: ${path.relative(ROOT, path.join(OUT, 'report.html'))} (${passed} passed, ${failed} failed)\n`;
}
