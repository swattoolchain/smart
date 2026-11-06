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

  // Quantity breaks: what the owner expects and what the cart charged, at each quantity tried.
  function tierTableHtml(t) {
    if (!t || !t.rows || !t.rows.length) return '';
    const mark = { over: '<b>Higher</b>', under: '<b>Lower</b>', refused: 'Cart refused', ok: '' };
    return `<table class="price-trail tier-table"><thead><tr><th>Quantity</th><th class="num">${t.source === 'page' ? 'Page says' : 'You expect'}</th><th class="num">Cart charges</th><th></th></tr></thead><tbody>${t.rows.map((r) => `<tr class="${r.state === 'over' ? 'up' : r.state === 'under' ? 'down' : ''}"><td>${esc(r.qty)}</td><td class="num">${esc(r.expect)} <span class="muted">(${esc(r.expectEach)} each)</span></td><td class="num">${r.charged == null ? '<span class="muted">–</span>' : `${esc(r.charged)} <span class="muted">(${esc(r.chargedEach)} each)</span>`}</td><td class="muted">${mark[r.state] || ''}</td></tr>`).join('')}${t.checkout ? `<tr class="${t.checkout.higher ? 'up' : ''}"><td>Checkout subtotal, ${esc(t.checkout.qty)}</td><td class="num"><span class="muted">Cart</span> ${esc(t.checkout.cart || '–')}</td><td class="num">${esc(t.checkout.money)}</td><td class="muted">${t.checkout.higher ? '<b>Higher</b>' : 'Same as the cart'}</td></tr>` : ''}</tbody></table>`;
  }
  window.tierTableHtml = tierTableHtml;

  function checkHtml(c) {
    const shot = c.evidence && c.evidence.screenshot;
    const errors = c.evidence && c.evidence.errors;
    const visual = c.evidence && c.evidence.visual;
    const ai = c.evidence && c.evidence.ai;
    return `<div class="chk ${esc(c.status)}">
      <div class="chk-top"><span class="st">${ST[c.status] || esc(c.status)}</span><h4>${esc(c.title)}</h4></div>
      <p class="detail">${esc(c.detail)}</p>
      ${c.fix && c.status !== 'pass' ? `<p class="fix"><b>How to fix:</b> ${esc(c.fix)}</p>` : ''}
      ${c.evidence && c.evidence.priceTrail ? priceTrailHtml(c.evidence.priceTrail) : ''}
      ${c.evidence && c.evidence.tierTable ? tierTableHtml(c.evidence.tierTable) : ''}
      ${errors ? `<p class="fix">${errors.map((e) => `<code>${esc(e.message)}</code>`).join('<br>')}</p>` : ''}
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
        lb.innerHTML = `<img src="${img.src}" alt="${img.alt}">`;
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
