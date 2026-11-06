// Renders a Store Guard scan result. Shared by the public report page and the dashboard.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ST = { pass: 'Pass', warn: 'Check', fail: 'Fail', skip: 'Skipped' };
  const VERDICT = { healthy: 'Healthy', warning: 'Needs attention', critical: 'Customers can\'t buy', locked: 'Password protected', blocked: 'Blocked by bot protection' };
  const COLOR = { healthy: 'var(--pass)', warning: 'var(--warn)', critical: 'var(--fail)', locked: 'var(--warn)', blocked: 'var(--warn)' };

  // What the shopper is asked to pay at each step (Prices stay the same, price rules).
  function priceTrailHtml(t) {
    if (!t || !t.steps || !t.steps.length) return '';
    const base = t.steps[0].minor;
    return `<table class="price-trail"><thead><tr><th>Step</th><th class="num">Price</th><th></th></tr></thead><tbody>${t.steps.map((s, i) => {
      const diff = i > 0 && s.minor != null && base != null && s.minor !== base;
      return `<tr class="${diff ? (s.minor > base ? 'up' : 'down') : ''}"><td>${esc(s.label)}</td><td class="num">${s.money == null ? '<span class="muted">Not shown</span>' : esc(s.money)}</td><td class="muted">${esc(s.note || '')}${diff ? ` <b>${s.minor > base ? 'Higher' : 'Lower'}</b>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  window.priceTrailHtml = priceTrailHtml;

  function checkHtml(c) {
    const shot = c.evidence && c.evidence.screenshot;
    const errors = c.evidence && c.evidence.errors;
    const visual = c.evidence && c.evidence.visual;
    const ai = c.evidence && c.evidence.ai;
    const variants = c.evidence && c.evidence.variants;
    const video = c.evidence && c.evidence.video;
    const videoGone = video && c.evidence.videoUntil && new Date(c.evidence.videoUntil) < new Date();
    const traffic = c.evidence && c.evidence.traffic;
    const secs = (ms) => (ms == null ? '–' : ms < 100 ? '<0.1 s' : `${(ms / 1000).toFixed(1)} s`);
    const agent = c.evidence && c.evidence.agent;
    return `<div class="chk ${esc(c.status)}">
      <div class="chk-top"><span class="st">${ST[c.status] || esc(c.status)}</span><h4>${esc(c.title)}</h4></div>
      <p class="detail">${esc(c.detail)}</p>
      ${c.fix && c.status !== 'pass' ? `<p class="fix"><b>How to fix:</b> ${esc(c.fix)}</p>` : ''}
      ${c.evidence && c.evidence.priceTrail ? priceTrailHtml(c.evidence.priceTrail) : ''}
      ${errors ? `<p class="fix">${errors.map((e) => `<code>${esc(e.message)}</code>`).join('<br>')}</p>` : ''}
      ${variants ? `<ul class="ai-findings variant-list">${variants.map((x) => `<li><b>${esc(x.name)}</b> <span class="muted">(${x.problem === 'unpublished' ? 'cart can\'t find it' : x.problem === 'error' ? 'no answer' : 'cart refuses it'})</span>${x.message ? `<br><span class="fix-inline">Store said: ${esc(x.message)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${video ? (videoGone ? '<p class="fix video-gone">The video replay was deleted after 7 days.</p>' : `<details class="video-replay"><summary>Watch the replay</summary><video controls preload="metadata" playsinline src="${esc(video)}"></video><span class="muted">Kept until ${esc(new Date(c.evidence.videoUntil).toLocaleDateString())}</span></details>`) : ''}
      ${traffic && traffic.steps ? `<table class="traffic-table"><thead><tr><th>Step</th><th>One shopper</th><th>${traffic.shoppers} at once (typical)</th><th>Slowest</th></tr></thead><tbody>${traffic.steps.map((x) => `<tr><td>${esc(x.label)}</td><td>${secs(x.alone)}</td><td>${secs(x.median)}</td><td>${secs(x.max)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${agent && agent.steps ? `<details class="agent-steps"><summary>What the AI shopper did (${agent.steps.length} steps)</summary><ol>${agent.steps.map((x) => `<li><b>${esc(x.did || x.action)}</b> <span class="muted">on ${esc(x.at)}</span>${x.thought ? `<br><span class="fix-inline">${esc(x.thought)}</span>` : ''}</li>`).join('')}</ol>${agent.friction && agent.friction.length ? `<p class="fix"><b>Got in the way:</b> ${agent.friction.map((f) => `${esc(f.issue)} <span class="muted">(${esc(f.at)})</span>`).join('; ')}</p>` : ''}</details>` : ''}
      ${shot ? `<img class="shot" src="${esc(shot)}" alt="Screenshot when '${esc(c.title)}' was checked" loading="lazy">` : ''}
      ${visual && visual.some((v) => v.status === 'changed') ? `<p class="fix">${visual.filter((v) => v.status === 'changed').map((v) => `${esc(v.key)}: ${v.ratio}% changed`).join(' · ')}</p>` : ''}
      ${ai ? `<ul class="ai-findings">${ai.map((f) => `<li><span class="sev ${f.severity === 'critical' ? 'fail' : f.severity === 'major' ? 'warn' : ''}">${f.severity}</span> ${esc(f.issue)} <span class="muted">(${esc(f.page)}, ${esc(f.device)})</span>${f.fix ? `<br><span class="fix-inline">Fix: ${esc(f.fix)}</span>` : ''}</li>`).join('')}</ul>` : ''}
    </div>`;
  }

  window.renderReport = function (el, result, opts = {}) {
    const host = (() => { try { return new URL(result.origin).host; } catch { return result.origin; } })();
    const v = result.verdict || 'warning';
    const score = result.score;
    const checks = result.checks || [];
    const problems = checks.filter((c) => c.status === 'fail' || c.status === 'warn');
    const order = { fail: 0, warn: 1 };
    const sev = { critical: 0, major: 1, minor: 2 };
    problems.sort((a, b) => order[a.status] - order[b.status] || sev[a.severity] - sev[b.severity]);
    const passes = checks.filter((c) => c.status === 'pass' || c.status === 'skip');
    const cats = (result.categories || [])
      .map((c) => `<div class="cat ${c.tested ? '' : 'untested'}"><span>${esc(c.label)}</span><b>${c.tested ? c.score : 'Not tested'}</b></div>`)
      .join('');
    const when = result.startedAt ? new Date(result.startedAt).toLocaleString() : '';
    el.innerHTML = `
      <div class="report-head">
        <div class="dial" style="--v:${score ?? 0};--c:${COLOR[v]}"><div><span><b>${score ?? '–'}</b><small>out of 100</small></span></div></div>
        <div>
          <span class="verdict v-${esc(v)}">${VERDICT[v] || esc(v)}</span>
          <h1>${esc(host)}</h1>
          <p>${esc(result.summary || '')}</p>
          <p class="muted" style="margin-top:6px;font-size:.9rem">${checks.length} checks · ${when}${result.durationMs ? ` · took ${Math.round(result.durationMs / 1000)}s` : ''}</p>
          ${opts.actions || ''}
        </div>
      </div>
      <div class="cats">${cats}</div>
      ${opts.afterHead || ''}
      ${problems.length ? `<h2 class="group-title">What needs fixing (${problems.length})</h2>${problems.map(checkHtml).join('')}` : `<h2 class="group-title">Nothing needs fixing</h2>`}
      <details class="passes"><summary>Show ${passes.length} checks that passed</summary>${passes.map(checkHtml).join('')}</details>
      ${result.cover ? `<h2 class="group-title">What customers see on mobile</h2><img class="shot" style="margin:0;max-width:300px;border:1px solid var(--line);border-radius:8px" src="${esc(result.cover)}" alt="Mobile screenshot of ${esc(host)}">` : ''}
    `;
    el.querySelectorAll('img.shot').forEach((img) =>
      img.addEventListener('click', () => {
        const lb = document.createElement('div');
        lb.className = 'lightbox';
        // Built as elements, not HTML: the alt text holds a check title from the store's own page.
        const big = document.createElement('img');
        big.src = img.src;
        big.alt = img.alt;
        lb.appendChild(big);
        lb.addEventListener('click', () => lb.remove());
        document.body.appendChild(lb);
      })
    );
  };

  window.waitingHtml = function (run) {
    const pos = run && run.position ? `<p>${run.position} scan(s) ahead of yours.</p>` : '';
    return `<div class="panel waiting"><div class="spin" role="status" aria-label="Testing"></div>
      <h2>Testing your store like a real customer</h2>${pos}
      <p class="muted">This takes 1–2 minutes. You can keep this page open.</p>
      <ol><li>Finds your products and collections</li><li>Searches, opens a product, picks a variant</li><li>Adds to cart and opens checkout (stops before payment)</li><li>Checks speed, SEO, accessibility and links</li></ol></div>`;
  };
  window.escHtml = esc;
})();
