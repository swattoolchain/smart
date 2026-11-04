/* Tharam Store Guard app. Every screen is a URL (#/...), so refreshing or live updates never lose your place. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.escHtml;

  const S = { me: null, admin: false, stores: [], catalog: null, storeId: null, dirty: false, wizard: null, token: 0, timer: null, route: '', stopping: new Set(), focus: null };

  // ---------- Helpers ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !path.startsWith('/api/auth')) { S.me = null; authView('login'); throw new Error('Please log in'); }
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong. Try again.'), { status: r.status });
    return j;
  }
  const host = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
  const parseTs = (ts) => (ts ? new Date(/[TZ]/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z') : null);
  function ago(ts) {
    const d = parseTs(ts);
    if (!d) return 'never';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  const exact = (ts) => (parseTs(ts) ? parseTs(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const time = (ts) => `<time datetime="${esc(ts || '')}" title="${esc(exact(ts))}">${esc(ago(ts))}</time>`;
  function inMin(m) {
    if (m == null) return '';
    if (m < 1) return 'any minute now';
    if (m < 60) return `in ${m} min`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h >= 24) return `in ${Math.round(h / 24)} d`;
    return `in ${h} h${mm ? ` ${mm} min` : ''}`;
  }
  function duration(a, b) {
    const s = Math.max(0, Math.round((parseTs(b) - parseTs(a)) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  const EVERY = { 60: 'Every hour', 180: 'Every 3 hours', 360: 'Every 6 hours', 720: 'Every 12 hours', 1440: 'Once a day' };
  const FULL_EVERY = { 720: 'Twice a day', 1440: 'Once a day', 10080: 'Once a week' };
  const VERDICT = { healthy: 'Healthy', warning: 'Needs attention', critical: "Customers can't buy", locked: 'Password protected', blocked: 'Blocked by bot protection' };
  const KIND = { full: 'Full check', journeys: 'Journey test', free: 'Free check' };
  const TRIGGER = { schedule: 'Scheduled', manual: 'Started by you', setup: 'First check', confirm: 'Confirmation re-test', free: 'Free check' };
  // "JavaScript errors" stays capitalised; "Mobile speed" becomes "mobile speed".
  const softLabel = (l) => (/^[A-Z][a-z]/.test(l) && !/^[A-Z][a-z]*[A-Z]/.test(l.split(' ')[0]) ? l[0].toLowerCase() + l.slice(1) : l);
  function listLabels(groups) {
    const l = groups.map((x) => softLabel(x.label));
    return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0] || '';
  }
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const scoreClass = (n) => (n >= 90 ? '' : n >= 60 ? 'mid' : 'low');

  function storeStatus(s) {
    if (s.active_run_id) return { key: 'running', label: 'Test running' };
    if (!s.last_run_at) return { key: 'paused', label: 'Not tested yet' };
    if (!s.monitoring) return { key: s.last_status || 'paused', label: `${VERDICT[s.last_status] || 'Checked'} · paused` };
    return { key: s.last_status || 'paused', label: VERDICT[s.last_status] || 'Checked' };
  }
  function monitoringLine(s) {
    if (s.active_run_id) return 'A test is running now';
    if (!s.last_run_at) return 'Monitoring starts after the first check';
    if (!s.monitoring) return 'Monitoring paused';
    return `Journey tests ${EVERY[s.config.journeyIntervalMin]?.toLowerCase() || ''} · next ${inMin(s.next_run_in)}`;
  }

  function toast(msg, kind = '') {
    $$('.toast').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  function confirmDialog({ title, body, confirm, danger }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'confirm';
      d.innerHTML = `<h2>${esc(title)}</h2><p>${body}</p><div class="row"><button class="btn secondary" value="no">Cancel</button><button class="btn ${danger ? 'danger-solid' : ''}" value="yes">${esc(confirm)}</button></div>`;
      document.body.appendChild(d);
      d.querySelectorAll('button').forEach((b) => (b.onclick = () => d.close(b.value)));
      d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
      d.showModal();
      d.querySelector('button.secondary').focus();
    });
  }
  function busy(btn, label) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true" style="border-color:rgba(255,255,255,.35);border-top-color:currentColor;width:15px;height:15px"></span>${esc(label)}`;
    return () => { btn.disabled = false; btn.innerHTML = prev; };
  }
  function lightbox(src, alt) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${esc(src)}" alt="${esc(alt || '')}">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  }

  const ICON = {
    overview: '<path d="M4 13a8 8 0 1 1 16 0"/><path d="m12 13 3.5-3.5"/><path d="M4 17h16"/>',
    suite: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
    runs: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    monitoring: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
    alerts: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    visual: '<rect x="3" y="5" width="12" height="10" rx="1.5"/><rect x="9" y="9" width="12" height="10" rx="1.5"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    stores: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    add: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
    account: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',
    reports: '<path d="M7 3.5h7l4.5 4.5V20a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4.5"/><path d="M9.5 17v-3M12.5 17v-5M15.5 17v-2"/>',
    catalog: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><path d="M4 15h16M4 19h16"/>',
    founder: '<path d="M12 3.5 14.4 9l5.6.5-4.3 3.8 1.3 5.7L12 16l-5 3 1.3-5.7L4 9.5 9.6 9z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    right: '<path d="m10 7 5 5-5 5"/>',
    printer: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M7 14h10v6H7z"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-5 4 4 2.5-2.5L20 18"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6"/><path d="M12 17h.01"/>',
    book: '<path d="M5 4.5h9a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h9"/>',
    collapse: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15"/><path d="m15 10-2 2 2 2"/>',
    sparkle: '<path d="M12 3.5 13.8 9 19.5 11l-5.7 2-1.8 5.5-1.8-5.5L4.5 11l5.7-2z"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    logout: '<path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',
    play: '<path d="M8 5.8v12.4a.6.6 0 0 0 .9.5l9.8-6.2a.6.6 0 0 0 0-1l-9.8-6.2a.6.6 0 0 0-.9.5z"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    publish: '<path d="M12 20V9"/><path d="m7.5 13.5 4.5-4.5 4.5 4.5"/><path d="M5 4.5h14"/>',
    shield: '<path d="M12 3.5 5 6v5.5c0 4.4 3 7.8 7 9 4-1.2 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  };
  const icon = (k, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  // ---------- Auth ----------
  function authView(mode) {
    clearTimeout(S.timer);
    document.body.className = 'app';
    const point = (t, d) => `<li><span class="ab-check">${icon('check', 14)}</span><span><b>${t}</b>${d}</span></li>`;
    document.body.innerHTML = `<div class="auth">
      <aside class="auth-brand">
        <a href="/" aria-label="Tharam home"><img src="/assets/brand/tharam-logo-dark.svg" alt="Tharam" width="120" height="34"></a>
        <div class="ab-body"><h2>Know your store works before your customers find out.</h2>
          <ul>${point('Shops your store like a customer', 'Search, product, add to cart and checkout, on desktop and phone, around the clock.')}
            ${point('Checks every theme before you publish', 'Draft against live, side by side, with one clear verdict.')}
            ${point('Watches your whole catalog', 'Zero prices, fake discounts, placeholder text and broken images, caught as they happen.')}</ul></div>
        <p class="ab-foot">Free during the beta · <a href="/checks">What we check</a></p>
      </aside>
      <main class="auth-main"><div class="auth-card">
        <h1>${mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
        <p class="sub">${mode === 'signup' ? 'Free during the beta. Nothing runs until you set up your store.' : 'Log in to see how your stores are doing.'}</p>
        <form id="auth" novalidate>
          ${mode === 'signup' ? '<div class="field"><label for="name">Your name</label><input id="name" name="name" autocomplete="name"></div>' : ''}
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" minlength="8" required>${mode === 'signup' ? '<p class="hint">At least 8 characters</p>' : ''}</div>
          <button class="btn block" type="submit">${mode === 'signup' ? 'Create account' : 'Log in'}</button>
          <p class="error-msg" id="auth-err" role="alert"></p>
        </form>
        <p class="switch-mode">${mode === 'signup' ? 'Already have an account? <button type="button" data-m="login">Log in</button>' : 'New to Tharam? <button type="button" data-m="signup">Create an account</button>'}</p>
      </div></main></div>`;
    $('[data-m]').onclick = (e) => authView(e.target.dataset.m);
    $('#auth').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const done = busy(e.target.querySelector('button[type=submit]'), mode === 'signup' ? 'Creating account' : 'Logging in');
      try {
        await api(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', body: fd });
        boot();
      } catch (ex) { $('#auth-err').textContent = ex.message; done(); }
    };
    $('#email').focus();
  }

  // ---------- Shell ----------
  function initials(u) {
    const src = (u.name || u.email || '?').trim();
    const parts = src.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (u.name && parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function railPref() { try { return localStorage.getItem('tg.rail') === 'collapsed'; } catch { return false; } }
  function shell() {
    document.body.className = 'app' + (railPref() ? ' rail-collapsed' : '');
    document.body.innerHTML = `
      <div class="layout">
        <aside class="rail" id="rail" aria-label="Main navigation">
          <div class="rail-brand"><a href="#/" aria-label="Tharam home"><img class="logo-full" src="/assets/brand/tharam-logo-dark.svg" alt="Tharam" width="98" height="28"><img class="logo-mark" src="/assets/brand/tharam-mark-dark.svg" alt="Tharam" width="30" height="30"></a></div>
          <nav class="rail-nav" id="side"></nav>
          <div class="rail-foot">
            <div class="plan">Free beta</div>
            <button type="button" class="rail-item rail-toggle" id="rail-toggle" data-label="Expand menu" aria-label="Collapse menu">${icon('collapse')}<span class="label">Collapse</span></button>
          </div>
        </aside>
        <div class="scrim" id="scrim"></div>
        <div class="workspace">
          <header class="topbar">
            <button class="icon-btn menu-btn" id="menu-btn" aria-label="Open navigation" aria-expanded="false">${icon('menu', 20)}</button>
            <div id="switch-slot" class="switch-slot"></div>
            <span class="spacer"></span>
            <a class="icon-btn hide-sm" href="/checks" target="_blank" rel="noopener" data-tip="What we check" aria-label="What we check">${icon('book', 19)}</a>
            <a class="icon-btn hide-sm tip-left" href="mailto:hello@tharam.store" data-tip="Help and support" aria-label="Help and support">${icon('help', 19)}</a>
            <span class="divider hide-sm"></span>
            <div class="menu">
              <button class="avatar" id="user-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">${esc(initials(S.me))}</button>
              <div class="pop right" id="user-pop" role="menu" hidden>
                <div class="pop-head"><b>${esc(S.me.name || 'Your account')}</b><span>${esc(S.me.email)}</span></div>
                <a href="#/account" role="menuitem">${icon('user', 16)}Account settings</a>
                ${S.admin ? `<a href="#/admin" role="menuitem">${icon('founder', 16)}Founder view</a>` : ''}
                <hr><button type="button" id="logout" role="menuitem">${icon('logout', 16)}Log out</button>
              </div>
            </div>
          </header>
          <main class="main" id="main" tabindex="-1"></main>
        </div>
      </div>`;
    const userBtn = $('#user-btn'), userPop = $('#user-pop');
    userBtn.onclick = (e) => { e.stopPropagation(); const open = userPop.hidden; closePops(); userPop.hidden = !open; userBtn.setAttribute('aria-expanded', String(open)); };
    $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); S.me = null; location.hash = ''; authView('login'); };
    $('#menu-btn').onclick = () => { const open = !document.body.classList.contains('nav-open'); document.body.classList.toggle('nav-open', open); $('#menu-btn').setAttribute('aria-expanded', String(open)); };
    $('#scrim').onclick = () => document.body.classList.remove('nav-open');
    const tg = $('#rail-toggle');
    const syncToggle = () => { const c = document.body.classList.contains('rail-collapsed'); tg.setAttribute('aria-label', c ? 'Expand menu' : 'Collapse menu'); };
    syncToggle();
    tg.onclick = () => {
      const c = document.body.classList.toggle('rail-collapsed');
      try { localStorage.setItem('tg.rail', c ? 'collapsed' : 'expanded'); } catch {}
      syncToggle();
    };
  }
  function closePops() {
    $$('.pop').forEach((p) => (p.hidden = true));
    $$('[aria-expanded="true"]').forEach((b) => b.id !== 'menu-btn' && b.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu, .switcher')) closePops(); });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-stop]');
    if (!b || !S.storeId) return;
    const id = Number(b.dataset.stop);
    if (!(await confirmDialog({ title: 'Stop this test?', body: 'Results collected so far are discarded and no alerts are sent. Scheduled monitoring carries on as normal.', confirm: 'Stop test', danger: true }))) return;
    const done = busy(b, 'Stopping');
    try { await api(`/api/stores/${S.storeId}/run/${id}/cancel`, { method: 'POST' }); S.stopping.add(id); render({ silent: true }); }
    catch (ex) { done(); toast(ex.message, 'error'); render({ silent: true }); }
  });
  setInterval(() => $$('[data-clock]').forEach((el) => (el.textContent = clock(Date.now() - Number(el.dataset.clock)))), 1000);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePops(); document.body.classList.remove('nav-open'); } });

  function sidebar(active) {
    const cur = S.stores.find((s) => s.id === S.storeId);
    const item = (href, ic, label, on, extra = '') => `<a class="rail-item" href="${href}" data-label="${esc(label)}" ${on ? 'aria-current="page"' : ''}>${icon(ic)}<span class="label">${esc(label)}</span>${extra}</a>`;
    const m = active.module === 'run' ? 'overview' : active.module;
    const at = (k) => active.store && m === k;
    const base = cur ? `#/s/${cur.id}` : '';
    $('#side').innerHTML = `${cur ? `
      <div class="rail-label">Monitor</div>
      ${item(base, 'overview', 'Overview', at('overview'))}
      ${item(`${base}/reports`, 'reports', 'Reports', at('reports'))}
      ${item(`${base}/runs`, 'runs', 'Runs', at('runs'))}
      ${item(`${base}/publish`, 'publish', 'Safe to publish', at('publish'))}
      ${item(`${base}/catalog`, 'catalog', 'Catalog', at('catalog'))}
      ${item(`${base}/visual`, 'visual', 'Visual changes', at('visual'))}
      ${item(`${base}/alerts`, 'alerts', 'Alerts', at('alerts'), cur.failing.length ? `<span class="badge" aria-label="${cur.failing.length} open">${cur.failing.length}</span>` : '')}
      <div class="rail-label">Configure</div>
      ${item(`${base}/suite`, 'suite', 'Test suite', at('suite'))}
      ${item(`${base}/monitoring`, 'monitoring', 'Monitoring', at('monitoring'))}
      ${item(`${base}/settings`, 'settings', 'Store settings', at('settings'))}` : ''}
      <div class="rail-label">Workspace</div>
      ${item('#/stores', 'stores', 'All stores', active.page === 'stores')}
      ${item('#/add', 'add', 'Add a store', active.page === 'add')}
      ${S.admin ? item('#/admin', 'founder', 'Founder view', active.page === 'admin') : ''}`;
    const slot = $('#switch-slot');
    if (!cur) { slot.innerHTML = ''; }
    else {
      const st = storeStatus(cur);
      slot.innerHTML = `<div class="switcher">
        <button type="button" id="sw-btn" aria-haspopup="listbox" aria-expanded="false" title="Switch store">
          <span class="dot ${esc(st.key)}" title="${esc(st.label)}"></span>
          <span class="s-text"><span class="s-name">${esc(cur.name || host(cur.url))}</span><span class="s-sub">${esc(host(cur.url))}</span></span>
          <span class="chev">${icon('chevron', 16)}</span></button>
        <div class="pop" id="sw-pop" role="listbox" hidden>
          <div class="pop-label">Your stores</div>
          ${S.stores.map((s) => `<a href="#/s/${s.id}" role="option" aria-selected="${s.id === cur.id}"><span class="dot ${esc(storeStatus(s).key)}"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name || host(s.url))}</span><span class="opt-sub">${esc(storeStatus(s).label)}</span></a>`).join('')}
          <hr><a href="#/stores">${icon('stores', 16)}All stores</a><a href="#/add">${icon('add', 16)}Add a store</a>
        </div></div>`;
      const sw = $('#sw-btn');
      sw.onclick = (e) => { e.stopPropagation(); const p = $('#sw-pop'); const open = p.hidden; closePops(); p.hidden = !open; sw.setAttribute('aria-expanded', String(open)); };
    }
    $$('#side a').forEach((a) => a.addEventListener('click', () => document.body.classList.remove('nav-open')));
  }

  // ---------- Router ----------
  async function loadStores() {
    S.stores = (await api('/api/stores')).stores;
  }
  function parseRoute(hash) {
    const h = hash.replace(/^#/, '') || '/';
    let m;
    if ((m = /^\/s\/(\d+)(?:\/([a-z]+))?(?:\/([\w-]+))?(?:\/([\w-]+))?$/.exec(h))) return { store: Number(m[1]), module: m[2] || 'overview', a: m[3] || null, b: m[4] || null };
    if ((m = /^\/account(?:\/(password))?$/.exec(h))) return { page: 'account', a: m[1] || null };
    if (h === '/stores') return { page: 'stores' };
    if (h === '/add') return { page: 'add' };
    if (h === '/admin') return { page: 'admin' };
    return { page: 'home' };
  }
  function poll(ms) {
    clearTimeout(S.timer);
    const t = S.token;
    S.timer = setTimeout(() => { if (t === S.token && !S.dirty && document.visibilityState === 'visible') render({ silent: true }); else if (t === S.token) poll(ms); }, ms);
  }
  async function render({ silent = false } = {}) {
    clearTimeout(S.timer);
    const token = ++S.token;
    const alive = () => token === S.token;
    const r = parseRoute(location.hash);
    S.route = location.hash;
    if (!silent) S.dirty = false;
    try {
      await loadStores();
      if (!alive()) return;
      if (r.store) {
        if (!S.stores.some((s) => s.id === r.store)) { location.hash = '#/stores'; return; }
        S.storeId = r.store;
        try { localStorage.setItem('tg.store', String(r.store)); } catch {}
      } else if (!S.stores.some((s) => s.id === S.storeId)) {
        let saved = null;
        try { saved = Number(localStorage.getItem('tg.store')); } catch {}
        S.storeId = S.stores.some((s) => s.id === saved) ? saved : S.stores[0]?.id || null;
      }
      if (r.page === 'home') {
        if (S.storeId) { location.replace('#/s/' + S.storeId); return; }
      }
      sidebar(r);
      const main = $('#main');
      if (!silent) { main.innerHTML = skeleton(); window.scrollTo(0, 0); }
      const ctx = { alive, main, r };
      if (r.store) await (STORE_PAGES[r.module] || STORE_PAGES.overview)(ctx, S.stores.find((s) => s.id === r.store));
      else await PAGES[r.page](ctx);
      if (!silent && alive()) { const h1 = main.querySelector('h1'); document.title = `${h1 ? h1.textContent + ' – ' : ''}Tharam`; }
    } catch (e) {
      if (!alive() || !S.me) return;
      $('#main').innerHTML = `<div class="main-inner"><div class="empty panel"><h2>This page didn't load</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`;
    }
  }
  function skeleton() {
    return `<div class="main-inner" aria-busy="true"><div class="sk" style="height:34px;width:38%;margin-bottom:12px"></div><div class="sk" style="height:16px;width:55%;margin-bottom:30px"></div><div class="sk" style="height:170px;margin-bottom:20px"></div><div class="grid-2"><div class="sk" style="height:220px"></div><div class="sk" style="height:220px"></div></div></div>`;
  }
  let reverting = false;
  window.addEventListener('hashchange', () => {
    if (reverting) { reverting = false; return; }
    if (S.dirty && !window.confirm('You have unsaved changes. Leave without saving?')) { reverting = true; location.hash = S.route; return; }
    S.dirty = false;
    if (S.me) render();
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  function tabs(base, items, current) {
    return `<nav class="tabs" aria-label="Sections">${items
      .map(([key, label, count]) => `<a href="${key ? `${base}/${key}` : base}" ${key === current ? 'aria-current="page"' : ''}>${esc(label)}${count ? `<span class="tab-count">${count}</span>` : ''}</a>`)
      .join('')}</nav>`;
  }
  // Page header. The store's name and status live in the top bar, so pages show a breadcrumb and title.
  function storeHead(s, title, { actions = '', crumb = '', meta = '' } = {}) {
    const name = esc(s.name || host(s.url));
    return `<div class="page-head"><div><div class="crumbs">${crumb || `<a href="#/s/${s.id}">${name}</a>`}</div><h1>${esc(title)}</h1>${meta ? `<div class="meta">${meta}</div>` : ''}</div>
      ${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  }
  const openStore = (s) => `<a class="icon-btn bordered" href="${esc(s.url)}" target="_blank" rel="noopener" data-tip="Open store" aria-label="Open store in a new tab">${icon('external', 17)}</a>`;
  // Every way of starting a test goes through the Run validations page, so nothing starts without a preview.
  const runLink = (s, label = 'Run validations', cls = 'btn') => `<a class="${cls}" href="#/s/${s.id}/run">${label}</a>`;
  function runButtons(s) {
    if (s.active_run_id) return `<a class="btn secondary" href="#/s/${s.id}/runs/${s.active_run_id}"><span class="pulse" aria-hidden="true"></span>View running test</a>`;
    return `<a class="btn" href="#/s/${s.id}/run">${icon('play', 16)}Run validations</a>`;
  }
  function bindRunButtons() {} // Stop buttons are handled by one listener below.
  const kindLabel = (r) => (r.trigger === 'manual' ? 'Validation run' : r.trigger === 'release' ? 'Publish check' : KIND[r.kind] || 'Run');

  // What a run does, in order. Mirrors src/live.js on the server.
  const PHASES = [
    { key: 'open', label: 'Open your store', sub: 'On a desktop and a phone-sized screen' },
    { key: 'journey', label: 'Shop like a customer', groups: ['journey.core', 'journey.collection', 'journey.search', 'journey.variant', 'journey.checkout', 'errors.js'] },
    { key: 'quality', label: 'Measure speed, SEO and accessibility', groups: ['speed', 'seo', 'a11y', 'links', 'policies'], full: true },
    { key: 'visual', label: 'Compare screenshots with the approved look', groups: ['visual'], full: true },
    { key: 'catalog', label: 'Check every product', groups: ['catalog', 'ai.copy'], full: true },
    { key: 'ai', label: 'AI review of how pages look', groups: ['ai.visual'], full: true },
  ];
  const EST = { 'journey.core': 14, 'journey.collection': 4, 'journey.search': 5, 'journey.variant': 4, 'journey.checkout': 8, 'errors.js': 1, speed: 24, seo: 5, a11y: 12, links: 14, policies: 4, catalog: 10, 'ai.visual': 20, 'ai.copy': 15, visual: 14 };
  const estimate = (keys) => {
    const sec = 8 + keys.reduce((n, k) => n + (EST[k] || 5), 0);
    return sec < 60 ? 'under a minute' : `about ${Math.ceil(sec / 60)} minutes`;
  };
  function planPhases(selected, kind) {
    const full = kind ? kind === 'full' : selected.some((k) => S.catalog.groups.find((g) => g.key === k)?.run === 'full');
    return PHASES.filter((p) => !p.groups || (p.groups.some((k) => selected.includes(k)) && (!p.full || full)))
      .filter((p) => !(p.key === 'ai' && !S.catalog.aiEnabled));
  }
  const groupsOf = (p, selected) => S.catalog.groups.filter((g) => p.groups?.includes(g.key) && selected.includes(g.key));

  function tally(c) {
    const parts = [`<span class="t-pass">${c.pass} passed</span>`];
    if (c.warn) parts.push(`<span class="t-warn">${c.warn} to check</span>`);
    if (c.fail) parts.push(`<span class="t-fail">${c.fail} failed</span>`);
    return parts.join('<span aria-hidden="true"> · </span>');
  }
  function liveState(run) {
    const lv = run.live || { phase: run.status === 'queued' ? 'queued' : 'open', disabled: [], steps: [], counts: { pass: 0, warn: 0, fail: 0 }, problems: [] };
    const selected = S.catalog.groups.filter((g) => !lv.disabled.includes(g.key)).map((g) => g.key);
    const phases = planPhases(selected, run.kind);
    const queued = run.status === 'queued' || lv.phase === 'queued';
    const idx = queued ? -1 : Math.max(0, phases.findIndex((p) => p.key === lv.phase));
    const pct = queued ? 3 : Math.min(96, Math.round(((idx + 0.5) / phases.length) * 100));
    const stopping = S.stopping.has(run.id);
    const startedMs = lv.steps[0]?.at || null;
    return { lv, selected, phases, queued, idx, pct, stopping, startedMs, current: phases[idx] };
  }
  const clock = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

  // Compact card on the Overview while a test runs.
  function liveCard(run, s) {
    const st = liveState(run);
    const what = st.stopping ? 'Stopping…' : st.queued ? (run.position ? `Waiting for ${plural(run.position, 'test')} ahead` : 'Starting in a moment') : `${st.current.label} · step ${st.idx + 1} of ${st.phases.length}`;
    return `<section class="panel live" aria-live="polite"><span class="spinner" aria-hidden="true"></span>
      <div class="live-text"><h2>${esc(kindLabel(run))} ${st.queued ? 'is queued' : 'is running'}</h2><p>${esc(what)}</p>
        <div class="progress" role="progressbar" aria-valuenow="${st.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><i style="width:${st.pct}%"></i></div>
        ${st.queued ? '' : `<p class="live-tally">${tally(st.lv.counts)} so far</p>`}</div>
      <div class="live-actions"><a class="btn secondary small" href="#/s/${s.id}/runs/${run.id}">View progress</a>${st.stopping ? '' : `<button type="button" class="btn ghost small" data-stop="${run.id}">${icon('stop', 15)}Stop</button>`}</div></section>`;
  }

  // Full live view on the run's own page.
  function liveDetail(run, s) {
    const st = liveState(run);
    const t0 = st.startedMs;
    const head = st.stopping ? 'Stopping the test' : st.queued ? 'Waiting to start' : st.current.label;
    const sub = st.stopping ? 'Closing the test browser. Nothing from this run is saved or alerted.'
      : st.queued ? (run.position ? `${plural(run.position, 'test')} ahead of this one. It starts automatically.` : 'Starts in a moment.')
      : `Step ${st.idx + 1} of ${st.phases.length}${t0 ? ` · running for <span data-clock="${t0}">${clock(Date.now() - t0)}</span>` : ''}`;
    const phaseList = st.phases.map((p, i) => {
      const state = st.queued ? 'pending' : i < st.idx ? 'done' : i === st.idx ? 'current' : 'pending';
      const gs = groupsOf(p, st.selected);
      const subText = p.sub || (gs.length > 1 ? listLabels(gs) : '');
      return `<li class="${state}"><span class="ph-mark" aria-hidden="true">${state === 'done' ? icon('check', 14) : state === 'current' ? '<span class="spinner"></span>' : ''}</span>
        <span><b>${esc(p.label)}</b>${subText ? `<span>${esc(subText[0].toUpperCase() + subText.slice(1))}</span>` : ''}</span>
        <span class="ph-state">${state === 'done' ? 'Done' : state === 'current' ? 'Now' : ''}</span></li>`;
    }).join('');
    const steps = [...st.lv.steps].reverse().slice(0, 14);
    const feed = steps.length
      ? `<ol class="feed">${steps.map((x) => `<li><span class="f-t">${t0 ? `+${((x.at - t0) / 1000).toFixed(1)}s` : ''}</span><span>${esc(x.text)}</span></li>`).join('')}</ol>`
      : `<p class="muted" style="margin:0">${st.queued ? 'Activity appears here once the test starts.' : 'Opening the store…'}</p>`;
    const problems = st.lv.problems || [];
    return `<section class="panel run-live" aria-live="polite">
        <div class="rl-head"><span class="spinner" aria-hidden="true"></span><div><h2>${esc(head)}</h2><p>${sub}</p></div>
          ${st.queued ? '' : `<p class="rl-tally">${tally(st.lv.counts)}</p>`}</div>
        <div class="progress big"><i style="width:${st.pct}%"></i></div></section>
      ${problems.length ? `<div class="notice"><p><b>Found so far:</b> ${problems.map((x) => esc(x.title)).join(', ')}. The full report is ready when the test finishes.</p></div>` : ''}
      <div class="grid-2 run-live-grid">
        <section class="panel"><h2>Plan</h2><p class="sub">${plural(st.selected.length, 'validation')} on ${esc(host(s.url))}. Stops before payment; no orders are placed.</p><ol class="phase-list">${phaseList}</ol></section>
        <section class="panel"><h2>Live activity</h2><p class="sub">What the test browser is doing, newest first.</p>${feed}</section>
      </div>`;
  }
  function runResult(r) {
    if (r.status === 'done') return `<span class="status-inline"><span class="dot ${esc(r.verdict)}"></span>${esc(VERDICT[r.verdict] || r.verdict)}</span>`;
    if (r.status === 'cancelled') return '<span class="status-inline muted"><span class="dot"></span>Stopped</span>';
    if (r.status === 'error') return '<span class="status-inline muted"><span class="dot"></span>Didn\'t finish</span>';
    return `<span class="pill running">${r.status === 'queued' ? 'Queued' : 'Running'}</span>`;
  }
  function strip(runs, n = 48) {
    const list = runs.slice(0, n).reverse();
    const cells = list.map((r) => {
      const k = r.status === 'done' ? r.verdict : r.status === 'error' || r.status === 'cancelled' ? 'error' : 'running';
      const what = r.status === 'done' ? VERDICT[r.verdict] || r.verdict : r.status === 'cancelled' ? 'Stopped' : r.status === 'error' ? "Didn't finish" : 'Running';
      return `<i class="${esc(k)}" title="${esc(`${kindLabel(r)} · ${exact(r.created_at)} · ${what}`)}"></i>`;
    });
    return `<div class="strip" role="img" aria-label="Results of the last ${list.length} tests">${cells.join('')}</div>`;
  }
  const LEGEND = `<div class="legend"><span><i style="background:#3aa864"></i>Healthy</span><span><i style="background:#e2a33a"></i>Needs attention</span><span><i style="background:#d93b30"></i>Customers can't buy</span><span><i style="background:#a7abbd"></i>Stopped or didn't finish</span></div>`;
  function problemsFrom(result) {
    const order = { fail: 0, warn: 1 }, sev = { critical: 0, major: 1, minor: 2 };
    return (result?.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => order[a.status] - order[b.status] || sev[a.severity] - sev[b.severity]);
  }

  // ---------- Store pages ----------
  const STORE_PAGES = {};

  STORE_PAGES.overview = async (ctx, s) => {
    const data = await api(`/api/stores/${s.id}/runs?limit=60`);
    if (!ctx.alive()) return;
    const runs = data.runs;
    const active = runs.find((r) => r.status === 'queued' || r.status === 'running');
    const lastDone = runs.find((r) => r.status === 'done');
    const [latest, activeRun, sc] = await Promise.all([lastDone ? api('/api/runs/' + lastDone.id) : null, active ? api('/api/runs/' + active.id) : null, api(`/api/stores/${s.id}/scorecard`).catch(() => null), S.catalog ? null : api('/api/catalog').then((c) => (S.catalog = c))]);
    if (!ctx.alive()) return;
    const res = latest?.result;
    const problems = problemsFrom(res);
    const done = runs.filter((r) => r.status === 'done');
    const ok = done.filter((r) => r.verdict !== 'critical').length;
    let body = '';
    if (activeRun && (activeRun.status === 'queued' || activeRun.status === 'running')) body += liveCard(activeRun, s);
    if (!res && !active) {
      body += `<section class="panel empty"><h2>Ready for its first check</h2><p>Your store is set up. The first full check tests the shopping journey, speed, SEO and accessibility, and saves today's look for visual comparisons. ${s.monitoring ? 'Scheduled monitoring starts after it finishes.' : 'Monitoring is paused, so only checks you start will run.'}</p>${runLink(s, 'Run first check')}</section>`;
    }
    if (res) {
      const cats = (res.categories || []).filter((c) => c.tested);
      body += `<section class="panel hero">
        <div class="dial" style="--v:${res.score ?? 0};--c:${{ healthy: 'var(--pass)', warning: 'var(--warn)', critical: 'var(--fail)', locked: 'var(--warn)', blocked: 'var(--warn)' }[res.verdict] || 'var(--skip)'}"><div><span><b>${res.score ?? '–'}</b><small>health</small></span></div></div>
        <div><span class="pill ${esc(res.verdict)}">${esc(VERDICT[res.verdict] || res.verdict)}</span><h2>${esc(res.summary)}</h2>
          <p class="when">${esc(KIND[lastDone.kind])} ${time(lastDone.finished_at || lastDone.created_at)} · <a href="#/s/${s.id}/reports/${lastDone.id}">Open report</a></p></div>
        <div class="cat-bars">${cats.map((c) => `<div class="cat-bar"><span>${esc(c.label)}</span><span class="track"><i class="${scoreClass(c.score)}" style="width:${c.score}%"></i></span><b>${c.score}</b></div>`).join('')}</div>
      </section>`;
      if (res.verdict === 'blocked') { const bc = res.checks.find((c) => c.id === 'fn.blocked'); body += `<div class="notice"><p><b>${esc(bc?.evidence?.vendor || 'Bot protection')} stopped our test browser.</b> ${esc(bc?.fix || '')}</p></div>`; }
      if (res.verdict === 'locked') body += `<div class="notice"><p>Your store is password protected. <a href="#/s/${s.id}/settings">Add the storefront password</a> so we can test the shopping journey.</p></div>`;
    }
    if (sc && (res || done.length)) body += scorecardPanel(sc, s);
    if (res || done.length) {
      body += `<div class="grid-2">
        <section class="panel"><div class="panel-head"><h2>What needs fixing</h2>${lastDone ? `<a href="#/s/${s.id}/reports/${lastDone.id}">Full report ${icon('right', 14)}</a>` : ''}</div>
          ${problems.length ? `<ul class="list">${problems.slice(0, 6).map((c) => `<li><a class="row" href="#/s/${s.id}/reports/${lastDone.id}" data-focus="${esc(c.id)}"><span class="sev ${c.status}">${c.status === 'fail' ? 'Fail' : 'Check'}</span><span><span class="t">${esc(c.title)}</span><span class="d">${esc(c.detail)}</span></span><span></span></a></li>`).join('')}</ul>${problems.length > 6 ? `<p class="muted" style="margin:10px 4px 0">and ${problems.length - 6} more in the report</p>` : ''}`
            : `<p class="muted" style="margin:0">Nothing to fix in the latest check.</p>`}
        </section>
        <section class="panel"><div class="panel-head"><h2>Recent tests</h2><a href="#/s/${s.id}/runs">All runs ${icon('right', 14)}</a></div>
          ${strip(runs)}<div class="strip-legend"><span>Older</span><span>Latest</span></div>${LEGEND}
          <div class="figures" style="margin:18px 0 0;grid-template-columns:repeat(2,minmax(0,1fr))">
            <div class="figure"><b>${sc?.buyability.week.runs ?? '–'}</b><span>checks in the last 7 days</span></div>
            <div class="figure"><b>${s.monitoring && s.last_run_at ? esc(inMin(s.next_run_in).replace(/^in /, '')) : '–'}</b><span>${s.monitoring ? (s.last_run_at ? 'until the next test' : 'monitoring starts after first check') : 'monitoring paused'}</span></div>
          </div>
        </section>
      </div>`;
      if (data.alerts.length) {
        body += `<section class="panel"><div class="panel-head"><h2>Recent alerts</h2><a href="#/s/${s.id}/alerts">All alerts ${icon('right', 14)}</a></div><ul class="list">${data.alerts.slice(0, 5).map((a) => `<li><div class="row"><span class="sev ${a.state === 'failing' ? 'fail' : 'ok'}">${a.state === 'failing' ? 'Broke' : 'Fixed'}</span><span><span class="t">${esc(a.title || (a.state === 'failing' ? 'Check failed' : 'Check recovered'))}</span><span class="d" style="-webkit-line-clamp:1">${esc(a.message || a.check_id)}</span></span><span class="r">${time(a.created_at)}</span></div></li>`).join('')}</ul></section>`;
      }
    }
    const st = storeStatus(s);
    const meta = `${res ? '' : `<span class="pill ${esc(st.key)}">${esc(st.label)}</span>`}<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(host(s.url))}</a>${s.platform ? `<span class="sep"></span><span>${esc(s.platform)}</span>` : ''}<span class="sep"></span><span>${esc(monitoringLine(s))}</span>`;
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, s.name || host(s.url), { crumb: 'Overview', meta, actions: openStore(s) + runButtons(s) })}${body}</div>`;
    $$('[data-focus]', ctx.main).forEach((a) => a.addEventListener('click', () => (S.focus = a.dataset.focus)));
    if (active || s.active_run_id) poll(S.stopping.size ? 1500 : 3000); // also refresh once if the run ended between loads
    else if (s.monitoring && s.last_run_at) poll(60000);
  };

  // Run validations: choose what to check, see the plan, then start. Nothing runs without this preview.
  function availability(g, s) {
    const shopify = !s.platform || /shopify/i.test(s.platform);
    if (!shopify && ((g.key.startsWith('journey.') && !g.locked) || g.key === 'catalog' || g.key === 'ai.copy')) return 'Shopify stores only for now';
    return null;
  }
  STORE_PAGES.run = async (ctx, s) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (!ctx.alive()) return;
    if (s.active_run_id) { location.replace(`#/s/${s.id}/runs/${s.active_run_id}`); return; }
    const name = s.name || host(s.url);
    const groups = S.catalog.groups.filter((g) => !g.ai || S.catalog.aiEnabled);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    const usable = groups.filter((g) => !availability(g, s));
    const keys = (list) => list.map((g) => g.key);
    const same = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
    const suite = keys(usable.filter((g) => g.locked || !s.config.disabled.includes(g.key)));
    const PRESETS = [
      { key: 'quick', title: 'Quick journey', desc: 'Can customers find a product, add it to the cart and reach checkout?', keys: keys(usable.filter((g) => g.run === 'journeys')) },
      { key: 'suite', title: 'Your test suite', desc: 'Everything switched on for scheduled full checks of this store.', keys: suite, tag: 'Recommended' },
      { key: 'all', title: 'Everything', desc: 'Every validation available, including ones switched off in your suite.', keys: keys(usable) },
    ].filter((p, i, all) => p.key !== 'all' || !same(p.keys, all[1].keys));
    let sel = [...suite];
    let saveSuite = false;

    const presetCards = PRESETS.map((p) => `<label class="preset"><input type="radio" name="preset" value="${p.key}">
      <span class="p-body"><span class="p-title"><b>${esc(p.title)}</b>${p.tag ? `<span class="pill healthy">${esc(p.tag)}</span>` : ''}</span><span class="p-desc">${esc(p.desc)}</span>
      <span class="p-meta">${plural(p.keys.length, 'validation')} · ${estimate(p.keys)}</span></span></label>`).join('');
    const areas = [...new Set(groups.map((g) => g.area))].map((area) => {
      const list = groups.filter((g) => g.area === area);
      return `<section class="pick-area" data-area="${esc(area)}"><header><h3>${esc(area)}</h3><span class="pa-count"></span><button type="button" class="btn link small" data-all="${esc(area)}">Select all</button></header>
        <div class="rows">${list.map((g) => {
          const na = availability(g, s);
          return `<label class="pick-row ${na ? 'na' : ''}"><input type="checkbox" name="g" value="${esc(g.key)}" ${g.locked ? 'checked disabled' : na ? 'disabled' : ''}>
            <span class="pr-text"><b>${esc(g.label)}</b><span>${esc(g.description.replace(/ Always on: this is the heart of every test\.$/, ''))}</span></span>
            <span class="pr-tags">${g.locked ? '<span class="tag">Always included</span>' : ''}${g.ai ? '<span class="tag ai">AI</span>' : ''}${na ? `<span class="tag">${esc(na)}</span>` : ''}${!g.locked && !na && s.config.disabled.includes(g.key) ? '<span class="tag">Off in your suite</span>' : ''}</span></label>`;
        }).join('')}</div></section>`;
    }).join('');

    const caveat = !s.has_password && s.last_status === 'locked'
      ? `<div class="notice"><p>Your store was password protected at the last check. <a href="#/s/${s.id}/settings">Add the storefront password</a> or only the homepage can be tested.</p></div>`
      : s.last_status === 'blocked' ? `<div class="notice"><p>The last check was stopped by bot protection. Allow Tharam in first, or this run will be blocked too.</p></div>` : '';

    ctx.main.innerHTML = `<div class="main-inner wide">${storeHead(s, 'Run validations', { crumb: `<a href="#/s/${s.id}">${esc(name)}</a> / Run validations` })}
      <p class="lede-sm">Choose what to check on ${esc(name)} right now. This doesn't change your monitoring schedule.</p>
      <div class="run-layout"><form id="runf" class="run-pick" novalidate>
        <fieldset class="presets"><legend class="sr-only">Start from</legend>${presetCards}</fieldset>
        <div class="pick-head"><h2>Validations</h2><p class="sub">Pick a starting point above, then adjust anything below.</p></div>
        ${areas}</form>
        <aside class="run-plan" aria-label="Run plan"><div class="panel" id="plan" aria-live="polite"></div></aside></div></div>`;

    const form = $('#runf');
    const draw = () => {
      $$('input[name=g]', form).forEach((i) => { if (!i.disabled) i.checked = sel.includes(i.value); });
      $$('.pick-area', form).forEach((sec) => {
        const ins = $$('input[name=g]', sec), on = ins.filter((i) => i.checked).length, avail = ins.filter((i) => !i.disabled);
        sec.querySelector('.pa-count').textContent = `${on} of ${ins.length}`;
        const b = sec.querySelector('[data-all]');
        b.hidden = !avail.length;
        b.textContent = avail.length && avail.every((i) => i.checked) ? 'Clear' : 'Select all';
      });
      const match = PRESETS.find((p) => same(p.keys, sel));
      $$('input[name=preset]', form).forEach((r) => (r.checked = r.value === match?.key));
      const phases = planPhases(sel);
      const differs = !same(sel, suite);
      const tp = s.config.testProduct ? s.config.testProduct.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Picked automatically (in stock, with variants)';
      $('#plan').innerHTML = `<p class="plan-kicker">${esc(match ? match.title : 'Custom selection')}</p>
        <h2 class="plan-sum">${plural(sel.length, 'validation')}</h2><p class="plan-time">Takes ${estimate(sel)}</p>
        <ol class="plan-steps">${phases.map((p) => { const gs = groupsOf(p, sel); const sub = p.sub || (gs.length > 1 ? listLabels(gs) : ''); return `<li><b>${esc(p.label)}</b>${sub ? `<span>${esc(sub[0].toUpperCase() + sub.slice(1))}</span>` : ''}</li>`; }).join('')}</ol>
        <dl class="plan-facts">
          <div><dt>Test product</dt><dd>${esc(tp)} <a href="#/s/${s.id}/suite/product">Change</a></dd></div>
          <div><dt>After the run</dt><dd>A report you can compare with earlier ones. If something new breaks, you're alerted as usual.</dd></div>
        </dl>
        <p class="plan-safe">${icon('shield', 18)}<span>Behaves like one shopper. It adds one item to a fresh cart and opens checkout, then stops before payment and empties the cart. No orders are placed.</span></p>
        ${caveat}
        ${differs ? `<label class="plan-save"><input type="checkbox" id="save-suite" ${saveSuite ? 'checked' : ''}><span>Also use this selection for scheduled checks</span></label>` : ''}
        <button type="button" class="btn block" id="start">${icon('play', 16)}Start run</button>
        <a class="btn ghost block" href="#/s/${s.id}">Cancel</a>`;
    };
    draw();
    form.addEventListener('change', (e) => {
      if (e.target.name === 'preset') sel = [...PRESETS.find((p) => p.key === e.target.value).keys];
      if (e.target.name === 'g') sel = $$('input[name=g]', form).filter((i) => i.checked).map((i) => i.value);
      draw();
    });
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-all]');
      if (!b) return;
      const ins = $$(`[data-area="${CSS.escape(b.dataset.all)}"] input[name=g]`, form).filter((i) => !i.disabled);
      const all = ins.every((i) => i.checked);
      ins.forEach((i) => (i.checked = !all));
      sel = $$('input[name=g]', form).filter((i) => i.checked).map((i) => i.value);
      draw();
    });
    $('#plan').addEventListener('change', (e) => { if (e.target.id === 'save-suite') saveSuite = e.target.checked; });
    $('#plan').addEventListener('click', async (e) => {
      const btn = e.target.closest('#start');
      if (!btn) return;
      const done = busy(btn, 'Starting');
      try {
        if (saveSuite && !same(sel, suite)) {
          const disabled = S.catalog.groups.filter((g) => !g.locked && !sel.includes(g.key) && !(g.ai && !S.catalog.aiEnabled)).map((g) => g.key);
          await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { disabled } } });
        }
        const r = await api(`/api/stores/${s.id}/run`, { method: 'POST', body: { groups: sel.filter((k) => byKey[k]) } });
        toast('Run started');
        location.hash = `#/s/${s.id}/runs/${r.runId}`;
      } catch (ex) { done(); toast(ex.message, 'error'); }
    });
  };

  // Scorecard: Buyability is the headline; the rest explain it.
  const pctTxt = (v) => (v == null ? '–' : `${v}%`);
  const durTxt = (m) => (m == null ? '–' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  const moneyTxt = (n, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(n); } catch { return String(n); } };
  function scorecardPanel(sc, s) {
    const b = sc.buyability, t = sc.timeToFix, r = sc.revenueAtRisk, c = sc.catalog, pb = sc.publishing;
    const tone = (v) => (v == null ? '' : v >= 99 ? 'good' : v >= 95 ? 'mid' : 'bad');
    const bars = b.daily.slice(-14).map((d) => `<i class="${d.pct == null ? 'none' : tone(d.pct)}" style="--h:${d.pct ?? 8}" title="${esc(d.day)}: ${d.pct == null ? 'no checks' : d.pct + '%'}"></i>`).join('');
    const tile = (label, value, sub, extra = '', cls = '') => `<div class="sc-tile ${cls}"><span class="sc-l">${label}</span><b class="sc-v">${value}</b><span class="sc-s">${sub}</span>${extra}</div>`;
    return `<section class="panel scorecard"><div class="panel-head"><h2>Scorecard</h2><span class="muted" style="font-size:12.5px">Last 30 days</span></div><div class="sc-grid">
      ${tile('Buyability · 7 days', `<span class="${tone(b.week.pct)}">${pctTxt(b.week.pct)}</span>`, `How often customers could buy. Today ${pctTxt(b.day.pct)} · 30 days ${pctTxt(b.month.pct)}`, `<div class="sc-bars" aria-label="Buyability by day, last 14 days">${bars}</div>`, 'lead')}
      ${tile('Time to fix', durTxt(t.medianMinutes), t.open ? `<span class="t-fail">${plural(t.open, 'problem')} still open</span>` : t.incidents ? `Typical, across ${plural(t.incidents, 'incident')}` : 'No buying problems in 30 days')}
      ${tile('Revenue at risk', r.amount != null ? moneyTxt(r.amount, r.currency) : `${r.hours} h`, r.amount != null ? `${r.hours} h when customers couldn’t buy` : r.hours ? `when customers couldn’t buy · <a href="#/s/${s.id}/settings">add daily sales</a> to see the amount` : `No lost buying time · <a href="#/s/${s.id}/settings">add daily sales</a>`)}
      ${tile('Product accuracy', c ? pctTxt(c.pct) : '–', c ? (c.withIssues ? `${c.withIssues} of ${c.products} products need fixing` : `All ${c.products} products look right`) : 'After the first full check')}
      ${tile('Changes checked', String(pb.checked), pb.checked ? (pb.caught ? `${plural(pb.caught, 'risky change')} caught before publishing` : 'All safe to publish') : `<a href="#/s/${s.id}/publish">Check a design before publishing</a>`)}
    </div></section>`;
  }

  // Test suite
  function suiteRows(groups, disabled, { shopify = true, aiEnabled = false } = {}) {
    const list = groups.filter((g) => !g.ai || aiEnabled);
    const areas = [...new Set(list.map((g) => g.area))];
    return areas.map((area) => `<section class="suite-area"><h3>${esc(area)}</h3><div class="rows">${list.filter((g) => g.area === area).map((g) => {
      const journeyOnly = g.key.startsWith('journey.') && !g.locked && !shopify;
      const on = g.locked || (!disabled.includes(g.key) && !journeyOnly);
      return `<label class="check-row ${on ? '' : 'off'}">
        <span class="switch"><input type="checkbox" name="g" value="${esc(g.key)}" ${on ? 'checked' : ''} ${g.locked || journeyOnly ? 'disabled' : ''} aria-label="${esc(g.label)}"><span></span></span>
        <span><b>${esc(g.label)}</b><p>${esc(g.description)}</p>${journeyOnly ? '<p class="unavailable">Available for Shopify stores. Other platforms are coming.</p>' : ''}</span>
        <span class="when">${g.locked ? 'Always on' : g.run === 'journeys' ? 'Every test' : 'Full check'}</span></label>`;
    }).join('')}</div></section>`).join('');
  }
  function readDisabled(root) {
    return $$('input[name=g]', root).filter((i) => !i.checked && !i.disabled).map((i) => i.value);
  }
  function savebar(root, { onSave, onDiscard, label = 'You have unsaved changes' }) {
    const bar = document.createElement('div');
    bar.className = 'savebar';
    bar.hidden = true;
    bar.innerHTML = `<span>${esc(label)}</span><button type="button" class="btn ghost small">Discard</button><button type="button" class="btn small">Save changes</button>`;
    root.appendChild(bar);
    const [discard, save] = bar.querySelectorAll('button');
    const mark = () => { S.dirty = true; bar.hidden = false; };
    discard.onclick = () => { S.dirty = false; onDiscard(); };
    save.onclick = async () => {
      const done = busy(save, 'Saving');
      try { await onSave(); S.dirty = false; bar.hidden = true; toast('Changes saved'); } catch (e) { toast(e.message, 'error'); } finally { done(); }
    };
    return mark;
  }

  STORE_PAGES.suite = async (ctx, s) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (!ctx.alive()) return;
    const tab = ctx.r.a === 'product' ? 'product' : null;
    const base = `#/s/${s.id}/suite`;
    const shopify = !s.platform || /shopify/i.test(s.platform);
    const head = storeHead(s, 'Test suite') + `<p class="lede-sm">Choose what Store Guard checks on ${esc(s.name || host(s.url))}. Journey checks run on every scheduled test; the rest run with the full check.</p>` + tabs(base, [[null, 'Checks'], ['product', 'Test product']], tab);
    if (!tab) {
      ctx.main.innerHTML = `<div class="main-inner narrow-page">${head}<form id="suite">${suiteRows(S.catalog.groups, s.config.disabled, { shopify, aiEnabled: S.catalog.aiEnabled })}</form></div>`;
      const form = $('#suite');
      const mark = savebar(form.parentElement, {
        onSave: async () => { await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { disabled: readDisabled(form) } } }); await loadStores(); },
        onDiscard: () => render(),
      });
      form.addEventListener('change', (e) => { e.target.closest('.check-row')?.classList.toggle('off', !e.target.checked); mark(); });
      return;
    }
    ctx.main.innerHTML = `<div class="main-inner narrow-page">${head}
      <div class="form-section" style="border-top:0;padding-top:0"><div><h3>Product used in tests</h3><p class="explain">Each test adds one of this product to a fresh cart, opens checkout, then empties the cart. Pick something that's usually in stock. If it sells out, we use another product and tell you.</p></div>
        <div class="controls">
          <div class="field"><label for="tp">Test product</label><select id="tp"><option value="">Choose automatically (recommended)</option>${s.config.testProduct ? `<option value="${esc(s.config.testProduct)}" selected>${esc(s.config.testProduct)}</option>` : ''}</select>
          <p class="hint" id="tp-hint">${s.config.testProduct ? 'Saved choice shown. Load your products to pick another.' : 'We pick an in-stock product with several variants, so variant selection is tested too.'}</p></div>
          <div class="inline-row"><button type="button" class="btn secondary small" id="load-products">Load my products</button></div>
        </div></div></div>`;
    const sel = $('#tp');
    const mark = savebar($('.main-inner', ctx.main), {
      onSave: async () => { await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { testProduct: sel.value || null } } }); await loadStores(); },
      onDiscard: () => render(),
    });
    sel.onchange = mark;
    $('#load-products').onclick = async (e) => {
      const done = busy(e.target, 'Loading products');
      try {
        const d = await api(`/api/stores/${s.id}/discover`, { method: 'POST' });
        if (!d.catalog?.length) { $('#tp-hint').textContent = d.locked ? 'Your store is password protected. Add the storefront password in Store settings first.' : 'We could not read your product list. Automatic choice will be used.'; return; }
        const cur = sel.value;
        sel.innerHTML = `<option value="">Choose automatically (recommended)</option>${d.catalog.map((p) => `<option value="${esc(p.handle)}" ${p.handle === cur ? 'selected' : ''}>${esc(p.title)}${p.variants > 1 ? ` (${p.variants} variants)` : ''}</option>`).join('')}`;
        $('#tp-hint').textContent = `Showing ${d.catalog.length} in-stock products.`;
      } catch (ex) { toast(ex.message, 'error'); } finally { done(); }
    };
  };

  // Runs
  STORE_PAGES.runs = async (ctx, s) => {
    if (ctx.r.a && /^\d+$/.test(ctx.r.a)) return runDetail(ctx, s, Number(ctx.r.a), ctx.r.b);
    const filter = ['full', 'journeys', 'problems', 'stopped'].includes(ctx.r.a) ? ctx.r.a : null;
    const data = await api(`/api/stores/${s.id}/runs?limit=200`);
    if (!ctx.alive()) return;
    let runs = data.runs;
    if (filter === 'full') runs = runs.filter((r) => r.kind === 'full');
    if (filter === 'journeys') runs = runs.filter((r) => r.kind === 'journeys');
    if (filter === 'problems') runs = runs.filter((r) => r.status === 'error' || (r.verdict && r.verdict !== 'healthy'));
    if (filter === 'stopped') runs = runs.filter((r) => r.status === 'cancelled');
    const active = data.runs.some((r) => r.status === 'queued' || r.status === 'running');
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Runs', { actions: runButtons(s) })}
      ${tabs(`#/s/${s.id}/runs`, [[null, 'All runs'], ['full', 'Full checks'], ['journeys', 'Journey tests'], ['problems', 'With problems'], ['stopped', 'Stopped']], filter)}
      ${runs.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Started</th><th>Type</th><th>Started by</th><th>Result</th><th class="num">Checks</th><th class="num">Score</th><th class="num">Took</th><th aria-label="Open"></th></tr></thead><tbody>
        ${runs.map((r) => `<tr class="link" data-href="#/s/${s.id}/runs/${r.id}" tabindex="0"><td><span class="cell-main">${time(r.created_at)}</span><div class="cell-sub">${esc(exact(r.created_at))}</div></td><td>${esc(kindLabel(r))}</td><td class="cell-sub">${esc(TRIGGER[r.trigger] || 'Scheduled')}</td>
          <td>${runResult(r)}</td><td class="num cell-sub">${r.checks ?? '–'}</td>
          <td class="num">${r.score ?? '–'}</td><td class="num">${r.finished_at ? duration(r.created_at, r.finished_at) : '–'}</td><td class="go">${icon('right', 16)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="panel empty"><h2>${filter ? 'No runs match this filter' : 'No runs yet'}</h2><p>${filter ? 'Try another tab.' : 'Run the first check to see results here.'}</p>${filter ? '' : runLink(s, 'Run first check')}</div>`}</div>`;
    $$('tr.link', ctx.main).forEach((tr) => { tr.onclick = () => (location.hash = tr.dataset.href); tr.onkeydown = (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; }; });
    if (active) poll(5000);
  };

  async function runDetail(ctx, s, runId, tab) {
    const run = await api('/api/runs/' + runId);
    if (!ctx.alive()) return;
    const base = `#/s/${s.id}/runs/${runId}`;
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (!ctx.alive()) return;
    const title = `${kindLabel(run)} #${run.id}`;
    const crumb = `<a href="#/s/${s.id}/runs">Runs</a> / ${esc(title)}`;
    const meta = `<p class="lede-sm">${esc(TRIGGER[run.trigger] || 'Scheduled')} · started ${esc(exact(run.created_at))}${run.finished_at ? ` · took ${duration(run.created_at, run.finished_at)}` : ''}</p>`;
    if (run.status === 'queued' || run.status === 'running') {
      const stopBtn = S.stopping.has(run.id) ? '' : `<button type="button" class="btn danger" data-stop="${run.id}">${icon('stop', 16)}Stop test</button>`;
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, title, { crumb, actions: stopBtn })}${meta}${liveDetail(run, s)}</div>`;
      poll(S.stopping.has(run.id) ? 1200 : 2500);
      return;
    }
    S.stopping.delete(run.id);
    if (!run.result) {
      const stopped = run.status === 'cancelled';
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, title, { crumb })}${meta}<div class="panel empty"><h2>${stopped ? 'You stopped this test' : "This test didn't finish"}</h2>
        <p>${stopped ? 'Nothing from it was saved and no alerts were sent. Scheduled monitoring carries on as normal.' : esc(run.error || 'Something interrupted the test.')}</p>
        ${stopped ? '' : '<p class="muted">Most often the store was slow or briefly unreachable. The next scheduled test tries again.</p>'}
        ${runLink(s, stopped ? 'Run validations' : 'Run again')}</div></div>`;
      return;
    }
    const steps = run.result.steps || [];
    ctx.main.innerHTML = `<div class="main-inner" style="max-width:940px">${storeHead(s, title, { crumb })}${meta}
      ${tabs(base, [[null, 'Report'], ['steps', 'What the test did', steps.length]], tab === 'steps' ? 'steps' : null)}<div id="tab"></div></div>`;
    const el = $('#tab');
    if (tab === 'steps') {
      const t0 = steps[0]?.at || 0;
      el.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th style="width:90px">Time</th><th>Step</th></tr></thead><tbody>${steps.map((x) => `<tr><td class="cell-sub">+${((x.at - t0) / 1000).toFixed(1)}s</td><td>${esc(x.text)}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted" style="margin-top:14px">Tests use a real browser at desktop and phone sizes, identify themselves as TharamStoreGuard, and stop before any payment step.</p>`;
      return;
    }
    const visualChanged = run.result.checks.some((c) => c.id === 'nf.visual' && c.status === 'warn');
    renderReport(el, run.result, { actions: `<div class="inline-row" style="margin-top:12px"><a class="btn small" href="#/s/${s.id}/reports/${run.id}">Open in Reports and compare</a>${visualChanged ? `<a class="btn small secondary" href="#/s/${s.id}/visual">Review visual changes</a>` : ''}</div>` });
  }

  // Monitoring
  STORE_PAGES.monitoring = async (ctx, s) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    const tab = ctx.r.a === 'history' ? 'history' : null;
    const base = `#/s/${s.id}/monitoring`;
    const head = storeHead(s, 'Monitoring') + tabs(base, [[null, 'Schedule'], ['history', 'History']], tab);
    if (tab === 'history') {
      const data = await api(`/api/stores/${s.id}/runs?limit=300`);
      if (!ctx.alive()) return;
      const done = data.runs.filter((r) => r.status === 'done');
      const within = (h) => done.filter((r) => Date.now() - parseTs(r.created_at) < h * 3600e3);
      const pct = (list) => (list.length ? `${Math.round((list.filter((r) => r.verdict !== 'critical').length / list.length) * 1000) / 10}%` : '–');
      const incidents = [];
      const alerts = [...data.alerts].reverse();
      for (const a of alerts) {
        if (a.state === 'failing') incidents.push({ check: a.check_id, msg: a.message, start: a.created_at, end: null });
        else { const open = [...incidents].reverse().find((i) => i.check === a.check_id && !i.end); if (open) open.end = a.created_at; }
      }
      incidents.reverse();
      ctx.main.innerHTML = `<div class="main-inner">${head}
        <div class="figures"><div class="figure"><b>${pct(within(24))}</b><span>could buy, last 24 hours</span></div><div class="figure"><b>${pct(within(24 * 7))}</b><span>could buy, last 7 days</span></div><div class="figure"><b>${pct(within(24 * 30))}</b><span>could buy, last 30 days</span></div></div>
        <section class="panel"><div class="panel-head"><h2>Last ${Math.min(data.runs.length, 100)} tests</h2><a href="#/s/${s.id}/runs">All runs ${icon('right', 14)}</a></div>${strip(data.runs, 100)}<div class="strip-legend"><span>Older</span><span>Latest</span></div>${LEGEND}</section>
        <section class="panel"><h2>Incidents</h2><p class="sub">Each time a check broke, and how long until it was fixed.</p>
          ${incidents.length ? `<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>What broke</th><th>Started</th><th>Fixed</th><th class="num">Lasted</th></tr></thead><tbody>${incidents.slice(0, 50).map((i) => `<tr><td><span class="cell-main">${esc(i.msg || i.check)}</span></td><td class="nowrap">${time(i.start)}</td><td class="nowrap">${i.end ? time(i.end) : '<span class="pill critical">Still broken</span>'}</td><td class="num">${i.end ? duration(i.start, i.end) : '–'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">No incidents yet.</p>'}
        </section></div>`;
      return;
    }
    const g = S.catalog.groups.filter((x) => !s.config.disabled.includes(x.key));
    const radios = (name, map, val) => `<div class="seg" role="radiogroup">${Object.entries(map).map(([k, l]) => `<label><input type="radio" name="${name}" value="${k}" ${Number(k) === val ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
    ctx.main.innerHTML = `<div class="main-inner">${head}<form class="settings-card" id="mon">
      <div class="form-section"><div><h3>Automatic monitoring</h3><p class="explain">When this is on, Store Guard tests your store on the schedule below and alerts you when something breaks or recovers.</p></div>
        <div class="controls"><label class="toggle-line"><span class="switch"><input type="checkbox" name="monitoring" ${s.monitoring ? 'checked' : ''}><span></span></span><span class="tl-text"><b>Monitor this store</b><span>${s.last_run_at ? (s.monitoring ? `Next test ${esc(inMin(s.next_run_in))}.` : 'Paused. Only checks you start will run.') : 'Starts after the first check.'}</span></span></label></div></div>
      <div class="form-section"><div><h3>Journey tests</h3><p class="explain">Quick tests of the shopping journey: ${esc(listLabels(g.filter((x) => x.run === 'journeys')))}. If one fails, we re-test every 30 minutes until it's fixed.</p></div>
        <div class="controls">${radios('journeyIntervalMin', EVERY, s.config.journeyIntervalMin)}</div></div>
      <div class="form-section"><div><h3>Full check</h3><p class="explain">Everything in journey tests, plus ${esc(listLabels(g.filter((x) => x.run === 'full')) || 'nothing else, because all full-check groups are off')}.</p></div>
        <div class="controls">${radios('fullIntervalMin', FULL_EVERY, s.config.fullIntervalMin)}</div></div>
      <div class="form-section"><div><h3>Change what's tested</h3><p class="explain">Switch individual checks on or off in the test suite.</p></div><div class="controls"><div><a class="btn secondary small" href="#/s/${s.id}/suite">Open test suite</a></div></div></div>
    </form></div>`;
    const form = $('#mon');
    const mark = savebar($('.main-inner', ctx.main), {
      onSave: async () => {
        const fd = new FormData(form);
        await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { monitoring: !!fd.get('monitoring'), config: { journeyIntervalMin: Number(fd.get('journeyIntervalMin')), fullIntervalMin: Number(fd.get('fullIntervalMin')) } } });
        await loadStores();
        render({ silent: true });
      },
      onDiscard: () => render(),
    });
    form.addEventListener('change', mark);
  };

  // Alerts
  STORE_PAGES.alerts = async (ctx, s) => {
    const tab = ctx.r.a === 'channels' ? 'channels' : null;
    const base = `#/s/${s.id}/alerts`;
    const head = storeHead(s, 'Alerts') + tabs(base, [[null, 'Incidents', s.failing.length || null], ['channels', 'Where alerts go']], tab);
    if (tab === 'channels') {
      ctx.main.innerHTML = `<div class="main-inner">${head}<form class="settings-card" id="ch">
        <div class="form-section"><div><h3>When we alert</h3><p class="explain">Once when a check breaks, and once when it recovers. Never the same problem twice. A newly failing critical check is re-tested a minute later before we alert, so network blips don't wake you up.</p></div>
          <div class="controls"><div class="notice info"><p>Alerts include what broke, how to fix it, and a link to the report with screenshots.</p></div></div></div>
        <div class="form-section"><div><h3>Email</h3><p class="explain">The address that receives alerts for this store.</p></div>
          <div class="controls"><div class="field"><label for="ae">Alert email</label><input id="ae" name="alertEmail" type="email" value="${esc(s.alert_email || '')}" autocomplete="email"></div></div></div>
        <div class="form-section"><div><h3>Slack</h3><p class="explain">Post alerts to a Slack channel. In Slack, open Apps, add <b>Incoming Webhooks</b>, choose a channel, and paste the webhook URL here.</p></div>
          <div class="controls"><div class="field"><label for="sl">Slack webhook URL <span class="muted" style="font-weight:400">(optional)</span></label><input id="sl" name="slack" placeholder="https://hooks.slack.com/services/…" value="${esc(s.slack_webhook || '')}"></div></div></div>
        <div class="form-section"><div><h3>Test your setup</h3><p class="explain">Sends a sample alert to the saved email and Slack channel.</p></div>
          <div class="controls"><div class="inline-row"><button type="button" class="btn secondary" id="test-alert">Send test alert</button><span id="test-result" class="muted" role="status"></span></div></div></div>
      </form></div>`;
      const form = $('#ch');
      const mark = savebar($('.main-inner', ctx.main), {
        onSave: async () => { const fd = new FormData(form); await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { alertEmail: fd.get('alertEmail'), slack: fd.get('slack') } }); await loadStores(); },
        onDiscard: () => render(),
      });
      form.addEventListener('input', mark);
      $('#test-alert').onclick = async (e) => {
        if (S.dirty) { toast('Save your changes first', 'error'); return; }
        const done = busy(e.target, 'Sending');
        try {
          const r = await api(`/api/stores/${s.id}/test-alert`, { method: 'POST' });
          const parts = [];
          parts.push(r.email ? `Email sent to ${s.alert_email}.` : r.emailConfigured ? 'Email could not be sent.' : 'Email sending is not set up on this server yet.');
          if (r.slack !== null) parts.push(r.slack ? 'Slack message sent.' : 'Slack rejected the message. Check the webhook URL.');
          $('#test-result').textContent = parts.join(' ');
        } catch (ex) { toast(ex.message, 'error'); } finally { done(); }
      };
      return;
    }
    const data = await api(`/api/stores/${s.id}/runs?limit=1`);
    if (!ctx.alive()) return;
    const open = s.failing;
    const alertFor = (id) => data.alerts.find((a) => a.check_id === id && a.state === 'failing');
    ctx.main.innerHTML = `<div class="main-inner">${head}
      <section class="panel"><h2>Broken right now</h2><p class="sub">Checks that are failing and haven't recovered yet.</p>
        ${open.length ? `<ul class="list">${open.map((f) => { const a = alertFor(f.check_id); return `<li><div class="row"><span class="sev fail">Open</span><span><span class="t">${esc(a?.title || a?.message || f.check_id)}</span>${a?.title && a.message ? `<span class="d">${esc(a.message)}</span>` : ''}</span><span class="r">since ${time(f.since)}</span></div></li>`; }).join('')}</ul>` : '<p class="muted" style="margin:0">Nothing is broken right now.</p>'}
      </section>
      <section class="panel"><h2>Alert history</h2><p class="sub">Every alert we sent for this store.</p>
        ${data.alerts.length ? `<ul class="list">${data.alerts.map((a) => `<li><div class="row"><span class="sev ${a.state === 'failing' ? 'fail' : 'ok'}">${a.state === 'failing' ? 'Broke' : 'Fixed'}</span><span>${a.title ? `<span class="t">${esc(a.title)}</span>` : ''}<span class="d" style="-webkit-line-clamp:3">${esc(a.state === 'failing' || !a.title ? a.message || a.check_id : 'Working again.')}</span></span><span class="r">${time(a.created_at)}</span></div></li>`).join('')}</ul>` : `<p class="muted" style="margin:0">No alerts yet. <a href="${base}/channels">Check where alerts go</a>.</p>`}
      </section></div>`;
  };

  // Visual changes
  STORE_PAGES.visual = async (ctx, s) => {
    const d = await api(`/api/stores/${s.id}/visual`);
    if (!ctx.alive()) return;
    const PG = { home: 'Homepage', product: 'Product page', collection: 'Collection page', cart: 'Cart' };
    const LABEL = new Proxy({}, { get: (_, k) => { const [pg, dev] = String(k).split('-'); return `${PG[pg] || pg} on ${dev || 'desktop'}`; } });
    const changed = d.shots.filter((x) => x.status === 'changed');
    const intro = `<p class="lede-sm">With every full check we take screenshots and compare them with the look you approved, so unintended changes from theme edits or app updates stand out.</p>`;
    if (!d.shots.length) {
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Visual changes')}${intro}<div class="panel empty"><h2>No screenshots yet</h2><p>${s.config.disabled.includes('visual') ? 'Visual checks are switched off in the test suite.' : 'They are taken during the next full check.'}</p>${s.config.disabled.includes('visual') ? `<a class="btn" href="#/s/${s.id}/suite">Open test suite</a>` : runLink(s, 'Run validations')}</div></div>`;
      return;
    }
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Visual changes', { actions: d.runId && changed.length ? '<button class="btn" id="approve">Approve latest look</button>' : '' })}${intro}
      ${changed.length ? `<div class="notice"><p>${changed.length} page${changed.length > 1 ? 's look' : ' looks'} different from the approved version. If you meant to change them, approve the latest look.</p></div>` : `<div class="notice ok"><p>Everything matches the approved look${d.checkedAt ? ` as of ${esc(exact(d.checkedAt))}` : ''}.</p></div>`}
      <div class="shots">${d.shots.map((x) => {
        const views = [['current', 'Latest', x.current], ['baseline', 'Approved', x.baseline], ['diff', 'Difference', x.diff]].filter((v) => v[2]);
        const status = x.status === 'changed' ? `<span class="pill warning">Changed · ${x.ratio}%</span>` : x.status === 'baseline' ? '<span class="pill">New baseline</span>' : x.status === 'same' ? '<span class="pill healthy">Matches</span>' : '';
        return `<article class="shot-card"><header><b>${esc(LABEL[x.key] || x.key)}</b>${status}</header>
          ${views.length > 1 ? `<div class="seg" role="radiogroup" aria-label="Choose view">${views.map((v, i) => `<label><input type="radio" name="v-${x.key}" value="${esc(v[2])}" ${i === 0 ? 'checked' : ''}><span>${v[1]}</span></label>`).join('')}</div>` : ''}
          <div class="frame">${views[0] ? `<img src="${esc(views[0][2])}" alt="${esc(LABEL[x.key])}" loading="lazy">` : '<span class="none">No screenshot</span>'}</div></article>`;
      }).join('')}</div></div>`;
    $$('.shot-card', ctx.main).forEach((card) => {
      card.addEventListener('change', (e) => { card.querySelector('.frame img').src = e.target.value; });
      card.querySelector('.frame img')?.addEventListener('click', (e) => lightbox(e.target.src, e.target.alt));
    });
    const ap = $('#approve');
    if (ap) ap.onclick = async () => {
      if (!(await confirmDialog({ title: 'Approve the latest look?', body: 'Future checks will compare against these screenshots.', confirm: 'Approve' }))) return;
      await api(`/api/stores/${s.id}/approve-visual`, { method: 'POST', body: { runId: d.runId } });
      toast('Latest look approved');
      render({ silent: true });
    };
  };

  // Store settings
  STORE_PAGES.settings = async (ctx, s) => {
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Store settings')}<form class="settings-card" id="set">
      <div class="form-section"><div><h3>Store details</h3><p class="explain">The name is how this store appears in Tharam and in alerts.</p></div>
        <div class="controls"><div class="field"><label for="nm">Store name</label><input id="nm" name="name" value="${esc(s.name || '')}" required maxlength="80"></div>
        <div class="field"><label for="ad">Store address</label><input id="ad" value="${esc(s.url)}" readonly><p class="hint">To test a different address, add it as a new store.</p></div></div></div>
      <div class="form-section"><div><h3>Sales <span class="muted" style="font-weight:400">(optional)</span></h3><p class="explain">Your average sales per day. We use it only to show how much revenue was at risk while customers couldn’t buy.</p></div>
        <div class="controls"><div class="inline-row"><div class="field" style="flex:1;margin:0"><label for="ds">Average daily sales</label><input id="ds" name="dailySales" type="number" min="0" step="1" inputmode="numeric" value="${esc(s.config.dailySales ?? '')}" placeholder="e.g. 50000"></div>
          <div class="field" style="width:120px;margin:0"><label for="cur">Currency</label><select id="cur" name="currency">${['', 'INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'AED'].map((c) => `<option value="${c}" ${c === (s.config.currency || '') ? 'selected' : ''}>${c || 'Store’s'}</option>`).join('')}</select></div></div></div></div>
      <div class="form-section"><div><h3>Storefront password</h3><p class="explain">Only needed while your store is password protected (for example before launch). We use it to open the store for testing and never show it again.</p></div>
        <div class="controls"><div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="off" placeholder="${s.has_password ? 'Saved. Type to replace' : 'Not set'}"></div>
        ${s.has_password ? '<label class="toggle-line"><span class="switch"><input type="checkbox" name="clearpw"><span></span></span><span class="tl-text"><b>Remove saved password</b><span>Use this once your store is public.</span></span></label>' : ''}</div></div>
    </form>
    <div class="settings-card danger-zone"><div class="form-section"><div><h3>Remove store</h3><p class="explain">Stops monitoring and deletes this store's runs, screenshots and alert history. This can't be undone.</p></div>
      <div class="controls"><div><button class="btn danger" type="button" id="del">Remove ${esc(s.name || host(s.url))}</button></div></div></div></div></div>`;
    const form = $('#set');
    const mark = savebar($('.main-inner', ctx.main), {
      onSave: async () => {
        const fd = new FormData(form);
        const body = { name: fd.get('name'), config: { dailySales: fd.get('dailySales') || null, currency: fd.get('currency') || null } };
        if (fd.get('clearpw')) body.password = '';
        else if (fd.get('password')) body.password = fd.get('password');
        await api(`/api/stores/${s.id}`, { method: 'PATCH', body });
        await loadStores();
        render({ silent: true });
      },
      onDiscard: () => render(),
    });
    form.addEventListener('input', mark);
    form.addEventListener('change', mark);
    $('#del').onclick = async () => {
      if (!(await confirmDialog({ title: `Remove ${s.name || host(s.url)}?`, body: 'Monitoring stops and all runs, screenshots and alerts for this store are deleted. This can\'t be undone.', confirm: 'Remove store', danger: true }))) return;
      await api(`/api/stores/${s.id}`, { method: 'DELETE' });
      S.storeId = null;
      try { localStorage.removeItem('tg.store'); } catch {}
      toast('Store removed');
      location.hash = '#/stores';
    };
  };


  // Reports: any report, compared with any earlier one.
  const fmtVal = (v, unit) => {
    if (v == null) return '–';
    if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
    if (unit === 'bytes') return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`;
    if (typeof v === 'number' && !Number.isInteger(v)) return v.toFixed(3);
    return String(v);
  };
  const STAT = { pass: ['Pass', 'ok'], warn: ['Check', 'warn'], fail: ['Fail', 'fail'], skip: ['Skipped', ''], null: ['Not run', ''] };
  const stat = (s) => { const [t, c] = STAT[s] || STAT.null; return `<span class="sev ${c}">${t}</span>`; };
  function delta(a, b) {
    if (a == null || b == null) return '';
    const d = a - b;
    if (d === 0) return '<span class="delta">No change</span>';
    return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`;
  }
  const reportLabel = (r) => `${parseTs(r.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · ${KIND[r.kind]}${r.score != null ? ` · ${r.score}` : ''}`;

  STORE_PAGES.reports = async (ctx, s) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    const runParam = ctx.r.a && /^\d+$/.test(ctx.r.a) ? Number(ctx.r.a) : null;
    const baseParam = ctx.r.b || 'prev';
    const [list, c] = await Promise.all([
      api(`/api/stores/${s.id}/reports`),
      api(`/api/stores/${s.id}/compare?${runParam ? `run=${runParam}&` : ''}base=${encodeURIComponent(baseParam)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    ]);
    if (!ctx.alive()) return;
    if (!c) {
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Reports')}<div class="panel empty"><h2>No reports yet</h2><p>Every check produces a report you can compare with earlier ones. Run the first check to get one.</p>${runLink(s, 'Run validations')}</div></div>`;
      return;
    }
    const run = c.run, b = c.base;
    const reports = list.reports;
    const older = reports.filter((x) => x.id < run.id);
    const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
    const baseSel = /^\d+$/.test(baseParam) ? baseParam : baseParam;
    const controls = `<div class="report-bar no-print">
      <div class="field"><label for="rep-run">Report</label><select id="rep-run">${reports.map((x) => opt(x.id, reportLabel(x), x.id === run.id)).join('')}</select></div>
      <div class="field"><label for="rep-base">Compare with</label><select id="rep-base">
        ${opt('prev', 'Previous check', baseSel === 'prev')}${opt('day', 'Same time a day before', baseSel === 'day')}${opt('week', 'Same time a week before', baseSel === 'week')}${opt('none', 'No comparison', baseSel === 'none')}
        ${older.length ? `<optgroup label="A specific report">${older.map((x) => opt(x.id, reportLabel(x), String(x.id) === String(baseSel))).join('')}</optgroup>` : ''}
      </select></div>
      <div class="report-bar-actions"><button class="icon-btn bordered tip-left" type="button" id="print" data-tip="Save as PDF" aria-label="Save as PDF">${icon('printer', 17)}</button></div></div>`;
    const res = run.result;
    const ch = c.changes;
    const compareLine = b
      ? `Compared with ${esc(KIND[b.kind])} from ${esc(exact(b.created_at))}${b.score != null ? ` (health ${b.score})` : ''}`
      : baseParam === 'none' ? 'Not compared with another report' : 'No earlier report to compare with yet';
    const vColor = { healthy: 'var(--pass)', warning: 'var(--warn)', critical: 'var(--fail)', locked: 'var(--warn)', blocked: 'var(--warn)' }[run.verdict] || 'var(--skip)';
    const summary = `<section class="panel report-summary">
      <div class="dial" style="--v:${run.score ?? 0};--c:${vColor}"><div><span><b>${run.score ?? '–'}</b><small>health</small></span></div></div>
      <div class="rs-text"><div class="inline-row"><span class="pill ${esc(run.verdict)}">${esc(VERDICT[run.verdict] || run.verdict)}</span>${b ? delta(run.score, b.score) : ''}</div>
        <h2>${esc(c.summary)}</h2>
        <p class="muted">${esc(KIND[run.kind])} · ${esc(exact(run.created_at))}${c.testedProduct ? ` · tested with “${esc(c.testedProduct.title)}”` : ''}<br>${compareLine}</p></div>
      ${b ? `<div class="change-counts"><button type="button" data-jump="changes" class="cc new"><b>${ch.new.length}</b><span>newly broken</span></button><button type="button" data-jump="changes" class="cc fixed"><b>${ch.fixed.length}</b><span>fixed</span></button><button type="button" data-jump="changes" class="cc still"><b>${ch.still.length}</b><span>still broken</span></button></div>`
        : `<div class="change-counts"><span class="cc still"><b>${ch.still.length}</b><span>to fix or check</span></span></div>`}
    </section>`;
    const changeItem = (x, kind) => `<li><div class="row"><span class="sev ${kind === 'fixed' ? 'ok' : x.a === 'fail' ? 'fail' : 'warn'}">${kind === 'fixed' ? 'Fixed' : x.a === 'fail' ? 'Fail' : 'Check'}</span><span><span class="t">${esc(x.title)}</span><span class="d">${esc(kind === 'fixed' ? x.prevDetail : x.detail)}</span></span><span></span></div></li>`;
    const changes = b ? `<section class="panel" id="changes"><h2>What changed</h2><p class="sub">${compareLine}.</p>
      <div class="grid-2 tight"><div><h3 class="col-h">Newly broken</h3>${ch.new.length ? `<ul class="list">${ch.new.map((x) => changeItem(x, 'new')).join('')}</ul>` : '<p class="muted">Nothing new broke.</p>'}</div>
      <div><h3 class="col-h">Fixed</h3>${ch.fixed.length ? `<ul class="list">${ch.fixed.map((x) => changeItem(x, 'fixed')).join('')}</ul>` : '<p class="muted">Nothing was fixed since then.</p>'}</div></div>
      ${ch.still.length ? `<details class="still"><summary>${ch.still.length} still broken from before</summary><ul class="list">${ch.still.map((x) => changeItem(x, 'still')).join('')}</ul></details>` : ''}</section>` : '';
    const areas = `<section class="panel" id="areas"><h2>Validation areas</h2><p class="sub">Every check this report ran, grouped by area${b ? ', with the result from the compared report' : ''}.</p>
      ${c.areas.map((a) => {
        const issues = a.counts.fail + a.counts.warn;
        return `<details class="area" ${issues ? 'open' : ''}><summary>
          <span class="area-name">${esc(a.label)}</span>
          <span class="area-score">${a.a ?? '–'}${b ? ` ${delta(a.a, a.b)}` : ''}</span>
          <span class="area-counts">${a.counts.pass ? `<span class="pill healthy">${a.counts.pass} passed</span>` : ''}${a.counts.warn ? `<span class="pill warning">${a.counts.warn} to check</span>` : ''}${a.counts.fail ? `<span class="pill critical">${a.counts.fail} failed</span>` : ''}${a.counts.skip ? `<span class="pill">${a.counts.skip} skipped</span>` : ''}</span>
          <span class="chev">${icon('chevron', 16)}</span></summary>
          <div class="table-wrap flat"><table class="data"><thead><tr><th style="width:84px">This report</th>${b ? '<th style="width:84px">Before</th>' : ''}<th>Check</th></tr></thead><tbody>
          ${a.checks.map((x) => `<tr data-check="${esc(x.id)}" class="${x.change === 'new' || x.change === 'worse' ? 'row-new' : x.change === 'fixed' ? 'row-fixed' : ''}"><td>${stat(x.a)}</td>${b ? `<td>${stat(x.b)}</td>` : ''}<td><span class="cell-main">${esc(x.title)}</span>${x.change === 'new' ? ' <span class="tag-new">New</span>' : x.change === 'fixed' ? ' <span class="tag-fixed">Fixed</span>' : ''}<div class="cell-sub">${esc(x.detail || x.prevDetail)}</div>${x.fix && (x.a === 'fail' || x.a === 'warn') ? `<div class="fix-line"><b>How to fix:</b> ${esc(x.fix)}</div>` : ''}${x.evidence?.screenshot ? `<div class="evidence"><button type="button" class="btn small secondary" data-shot="${esc(x.evidence.screenshot)}">${icon('image', 14)}Screenshot</button></div>` : ''}${x.evidence?.ai ? `<ul class="ai-findings" style="margin-left:0">${x.evidence.ai.map((f) => `<li><span class="sev ${f.severity === 'critical' ? 'fail' : f.severity === 'major' ? 'warn' : ''}">${esc(f.severity)}</span> ${esc(f.issue)} <span class="muted">(${esc(f.page)}, ${esc(f.device)})</span>${f.fix ? `<br><span class="fix-inline">Fix: ${esc(f.fix)}</span>` : ''}</li>`).join('')}</ul>` : ''}</td></tr>`).join('')}
          </tbody></table></div></details>`;
      }).join('')}</section>`;
    const metrics = c.metrics.length ? `<section class="panel" id="speed"><h2>Speed and page weight</h2><p class="sub">Measured on a phone-sized screen. Changes under 10% are treated as noise.</p>
      <div class="table-wrap flat"><table class="data"><thead><tr><th>Page</th><th>Measure</th><th class="num">This report</th>${b ? '<th class="num">Before</th><th class="num">Change</th>' : ''}</tr></thead><tbody>
      ${c.metrics.map((m) => `<tr><td class="cell-sub">${esc(m.page)}</td><td>${esc(m.name)}</td><td class="num">${fmtVal(m.a, m.unit)}</td>${b ? `<td class="num">${fmtVal(m.b, m.unit)}</td><td class="num"><span class="trend ${m.trend}">${m.trend === 'worse' ? 'Worse' : m.trend === 'better' ? 'Better' : 'Same'}</span></td>` : ''}</tr>`).join('')}
      </tbody></table></div></section>` : '';
    const catPanel = c.catalog && c.catalog.count ? (() => {
      const cat = c.catalog, t = cat.totals;
      const changed = t ? t.changed + t.added + t.removed : 0;
      const parts = t ? [t.price && `${t.price} price`, t.sale && `${t.sale} sale`, t.stock && `${t.stock} stock`, t.description && `${t.description} description`, t.added && `${t.added} added`, t.removed && `${t.removed} removed`].filter(Boolean) : [];
      return `<section class="panel" id="catalog"><div class="panel-head"><h2>Catalog</h2><a href="#/s/${s.id}/catalog">Open catalog ${icon('right', 14)}</a></div>
        <div class="figures" style="margin:0"><div class="figure"><b>${cat.count}${cat.truncated ? '+' : ''}</b><span>products checked</span></div>
        <div class="figure"><b>${(cat.issues || []).length}</b><span>catalog issues</span></div>
        <div class="figure"><b>${changed}</b><span>changed since compared</span></div></div>
        ${parts.length ? `<p class="muted" style="margin:14px 0 0">Changes: ${esc(parts.join(', '))}.</p>` : ''}</section>`;
    })() : '';
    const aiPanel = c.ai && c.ai.findings && c.ai.findings.length ? `<section class="panel" id="ai"><h2>AI visual review</h2><p class="sub">What an AI reviewer noticed looking at your pages like a shopper.</p>
      <ul class="ai-findings" style="margin-left:0">${c.ai.findings.map((f) => `<li><span class="sev ${f.severity === 'critical' ? 'fail' : f.severity === 'major' ? 'warn' : ''}">${esc(f.severity)}</span> ${esc(f.issue)} <span class="muted">(${esc(f.page)}, ${esc(f.device)})</span>${f.fix ? `<br><span class="fix-inline">Fix: ${esc(f.fix)}</span>` : ''}</li>`).join('')}</ul></section>` : '';
    const ta = c.timings.a.filter((x) => x.ms != null), tb = c.timings.b;
    const timings = ta.length ? `<section class="panel" id="timings"><h2>Journey step timings</h2><p class="sub">How long each step of the shopping journey took, including the page settling.</p>
      <div class="table-wrap flat"><table class="data"><thead><tr><th>Step</th><th class="num">This report</th>${b ? '<th class="num">Before</th>' : ''}</tr></thead><tbody>
      ${ta.map((x) => { const prev = tb.find((y) => y.text === x.text && y.ms != null); return `<tr><td>${esc(x.text)}</td><td class="num">${fmtVal(x.ms, 'ms')}</td>${b ? `<td class="num">${prev ? fmtVal(prev.ms, 'ms') : '–'}</td>` : ''}</tr>`; }).join('')}
      </tbody></table></div></section>` : '';
    const DEV = [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Mobile']].filter(([d]) => c.visual.some((v) => v.key.endsWith(d)));
    const visual = c.visual.length ? `<section class="panel" id="devices"><div class="panel-head"><h2>Devices and visual changes</h2>
        <div class="seg" role="radiogroup" aria-label="Device">${DEV.map(([d, l], i) => `<label><input type="radio" name="dev" value="${d}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <p class="sub">${b ? 'Screenshots from this report and the compared one. Difference highlights changed pixels in red.' : 'Screenshots from this report.'}</p>
      <div class="shots" id="dev-shots"></div></section>` : '';
    const jumps = [['changes', 'What changed', changes], ['areas', 'Validation areas', areas], ['catalog', 'Catalog', catPanel], ['ai', 'AI review', aiPanel], ['speed', 'Speed', metrics], ['timings', 'Step timings', timings], ['devices', 'Devices', visual]].filter((x) => x[2]);
    const jumpBar = `<nav class="jump no-print" aria-label="Sections of this report">${jumps.map(([id, l]) => `<button type="button" data-jump="${id}">${esc(l)}</button>`).join('')}</nav>`;
    ctx.main.innerHTML = `<div class="main-inner report-page">${storeHead(s, 'Reports', { actions: runButtons(s) })}${controls}${summary}${jumpBar}${changes}${areas}${catPanel}${aiPanel}${metrics}${timings}${visual}</div>`;
    $$('[data-jump]', ctx.main).forEach((b) => (b.onclick = () => document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
    if (S.focus) {
      const row = ctx.main.querySelector(`[data-check="${CSS.escape(S.focus)}"]`);
      S.focus = null;
      if (row) { row.closest('details').open = true; row.classList.add('flash'); setTimeout(() => row.scrollIntoView({ block: 'center' }), 50); }
    }

    const go = (runId, base) => (location.hash = `#/s/${s.id}/reports/${runId}/${base}`);
    $('#rep-run').onchange = (e) => go(e.target.value, /^\d+$/.test(baseParam) ? 'prev' : baseParam);
    $('#rep-base').onchange = (e) => go(run.id, e.target.value);
    $('#print').onclick = () => { $$('details', ctx.main).forEach((d) => (d.open = true)); window.print(); };
    $$('[data-shot]', ctx.main).forEach((x) => (x.onclick = () => lightbox(x.dataset.shot, 'Screenshot')));
    const PAGE = { home: 'Homepage', product: 'Product page' };
    const drawDevice = (dev) => {
      const el = $('#dev-shots');
      if (!el) return;
      el.innerHTML = c.visual.filter((v) => v.key.endsWith(dev)).map((v) => {
        const views = [['a', 'This report', v.a], ['b', 'Before', v.b], ['diff', 'Difference', v.diff]].filter((x) => x[2]);
        const chip = v.ratio == null ? '' : v.ratio > 12 ? `<span class="pill warning">${v.ratio}% changed</span>` : v.ratio > 0.5 ? `<span class="pill">${v.ratio}% changed</span>` : '<span class="pill healthy">No visible change</span>';
        const canExplain = S.catalog.aiEnabled && v.a && v.b && b;
        return `<article class="shot-card" data-key="${esc(v.key)}"><header><b>${PAGE[v.key.split('-')[0]]}</b>${chip}</header>
          ${views.length > 1 ? `<div class="seg" role="radiogroup" aria-label="View">${views.map((x, i) => `<label><input type="radio" name="v-${v.key}" value="${esc(x[2])}" ${i === 0 ? 'checked' : ''}><span>${x[1]}</span></label>`).join('')}</div>` : ''}
          <div class="frame">${views[0] ? `<img src="${esc(views[0][2])}" alt="${esc(PAGE[v.key.split('-')[0]])} on ${dev}" loading="lazy">` : '<span class="none">No screenshot</span>'}</div>
          ${canExplain ? `<div class="explain-row"><button type="button" class="btn secondary small explain-btn">${icon('sparkle', 14)}Explain this change</button><div class="explain-out" hidden></div></div>` : ''}</article>`;
      }).join('');
      $$('.shot-card', el).forEach((card) => {
        card.addEventListener('change', (e) => { if (e.target.name?.startsWith('v-')) card.querySelector('.frame img').src = e.target.value; });
        card.querySelector('.frame img')?.addEventListener('click', (e) => lightbox(e.target.src, e.target.alt));
        const eb = card.querySelector('.explain-btn');
        if (eb) eb.onclick = async () => {
          const out = card.querySelector('.explain-out');
          const done = busy(eb, 'Asking AI');
          try {
            const r = await api(`/api/stores/${s.id}/explain-change`, { method: 'POST', body: { runId: run.id, baseRunId: b.id, key: card.dataset.key } });
            out.hidden = false;
            out.innerHTML = `<p class="explain-sum">${esc(r.summary)}</p>${r.changes.length ? `<ul class="list">${r.changes.map((x) => `<li><div class="row"><span class="sev ${x.verdict === 'suspicious' ? 'fail' : 'ok'}">${x.verdict === 'suspicious' ? 'Suspicious' : 'Intended'}</span><span><span class="t">${esc(x.change)}</span><span class="d">${esc(x.why)}</span></span><span></span></div></li>`).join('')}</ul>` : '<p class="muted">No meaningful change found.</p>'}`;
            eb.remove();
          } catch (ex) { toast(ex.message, 'error'); done(); }
        };
      });
    };
    if (DEV.length) { drawDevice(DEV[0][0]); $$('input[name=dev]', ctx.main).forEach((r) => (r.onchange = () => drawDevice(r.value))); }
  };


  // Catalog: product-level issues and changes, with period comparison.
  const CAT_TYPE = { pricing: 'Pricing', content: 'Text', media: 'Images', data: 'Data', counts: 'Counts', copy: 'AI copy review' };
  let CUR = null;
  const money = (v) => {
    if (v == null) return '–';
    if (!CUR) return Number(v).toLocaleString();
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: CUR, maximumFractionDigits: Number.isInteger(Number(v)) ? 0 : 2 }).format(v); } catch { return `${v} ${CUR}`; }
  };
  STORE_PAGES.catalog = async (ctx, s) => {
    const runParam = ctx.r.a && /^\d+$/.test(ctx.r.a) ? Number(ctx.r.a) : null;
    const baseParam = ctx.r.b || 'prev';
    const tab = ['issues', 'changes', 'products'].includes(ctx.r.a) ? ctx.r.a : (ctx.r.b && ['issues', 'changes', 'products'].includes(ctx.r.b) ? ctx.r.b : 'issues');
    const c = await api(`/api/stores/${s.id}/catalog?base=${encodeURIComponent(baseParam)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    if (!ctx.alive()) return;
    if (!c) {
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Catalog')}<div class="panel empty"><h2>No catalog snapshot yet</h2><p>Every full check reads your whole product catalog, validates it, and logs what changed. Run a full check to get started.</p>${s.config.disabled.includes('catalog') ? `<a class="btn" href="#/s/${s.id}/suite">Turn on Catalog checks</a>` : runLink(s, 'Run validations')}</div></div>`;
      return;
    }
    const base = `#/s/${s.id}/catalog`;
    CUR = c.currency || null;
    const sum = c.summary;
    const head = storeHead(s, 'Catalog') + `<p class="lede-sm">${sum.products} products${c.run.truncated ? ' (first 2,000)' : ''} read ${time(c.run.takenAt)}${c.base ? `, compared with ${time(c.base.takenAt)}` : ''}.</p>`;
    const figures = `<div class="figures" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      <div class="figure"><b>${sum.products}</b><span>products</span></div>
      <div class="figure"><b>${sum.withIssues}</b><span>with issues</span></div>
      <div class="figure"><b style="color:${sum.critical ? 'var(--fail)' : 'inherit'}">${sum.critical}</b><span>serious issues</span></div>
      <div class="figure"><b>${c.totals ? c.totals.changed + c.totals.added + c.totals.removed : '–'}</b><span>changed since compared</span></div></div>`;
    const tabsBar = tabs(base, [['issues', 'Issues', sum.withIssues || null], ['changes', 'Changes', c.totals ? (c.totals.changed + c.totals.added + c.totals.removed) || null : null], ['products', 'All products', sum.products]], tab);
    let body = '';
    if (tab === 'issues') {
      const types = Object.keys(c.byType);
      body = types.length ? types.map((t) => `<section class="panel"><h2>${esc(CAT_TYPE[t] || t)} <span class="muted" style="font-weight:400">(${c.byType[t].length})</span></h2>
        <ul class="list">${c.byType[t].slice(0, 60).map((i) => `<li><a class="row" href="${esc(s.url)}/products/${esc(i.handle)}" target="_blank" rel="noopener"><span class="sev ${i.severity === 'critical' ? 'fail' : i.severity === 'major' ? 'warn' : ''}">${i.severity === 'critical' ? 'Serious' : i.severity === 'major' ? 'Issue' : 'Minor'}</span><span><span class="t">${esc(i.title)}</span><span class="d">${esc(i.message)}</span></span><span class="r" aria-label="Open product in your store">${icon('external', 15)}</span></a></li>`).join('')}</ul>
        ${c.byType[t].length > 60 ? `<p class="muted" style="margin:10px 4px 0">and ${c.byType[t].length - 60} more</p>` : ''}</section>`).join('') : '<div class="panel"><p class="muted" style="margin:0">No catalog issues found. Nice.</p></div>';
    } else if (tab === 'changes') {
      if (!c.totals) body = '<div class="panel"><p class="muted" style="margin:0">No earlier snapshot to compare with yet. The next full check will show changes.</p></div>';
      else {
        const t = c.totals;
        const chips = [['price', t.price, 'price changes'], ['sale', t.sale, 'sale changes'], ['stock', t.stock, 'stock changes'], ['description', t.description, 'description edits'], ['images', t.images, 'image changes'], ['added', t.added, 'added'], ['removed', t.removed, 'removed']].filter((x) => x[1]);
        body = `${chips.length ? `<div class="chips">${chips.map((x) => `<span class="pill">${x[1]} ${x[2]}</span>`).join('')}</div>` : ''}
        ${c.changes.length ? `<section class="panel"><ul class="list">${c.changes.map((ch) => catChange(ch, s)).join('')}</ul></section>` : '<div class="panel"><p class="muted" style="margin:0">Nothing in the catalog changed.</p></div>'}`;
      }
    } else {
      body = `<div class="table-wrap"><table class="data"><thead><tr><th>Product</th><th>Price</th><th>Stock</th><th class="num">Issues</th><th>Changed</th><th aria-label="Open"></th></tr></thead><tbody>
        ${c.products.map((p) => `<tr class="link" data-href="${esc(s.url)}/products/${esc(p.handle)}" tabindex="0"><td><div class="prod-cell">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<span class="noimg"></span>'}<span><span class="cell-main">${esc(p.title)}</span><div class="cell-sub">${p.variants} variant${p.variants > 1 ? 's' : ''} · ${p.images} image${p.images === 1 ? '' : 's'}</div></span></div></td>
          <td class="nowrap">${money(p.price)}${p.maxPrice && p.maxPrice !== p.price ? ` – ${money(p.maxPrice)}` : ''}</td>
          <td>${p.available ? '<span class="status-inline"><span class="dot healthy"></span>In stock</span>' : '<span class="status-inline"><span class="dot"></span>Sold out</span>'}</td>
          <td class="num">${p.issues ? `<span class="pill ${p.worst === 'critical' ? 'critical' : p.worst === 'major' ? 'warning' : ''}">${p.issues}</span>` : '<span class="muted">0</span>'}</td>
          <td class="cell-sub">${p.changed === 'added' ? 'New' : p.changed === 'changed' ? 'Edited' : '–'}</td><td class="go">${icon('external', 15)}</td></tr>`).join('')}
      </tbody></table></div>${c.products.length >= 500 ? '<p class="muted" style="margin-top:12px">Showing the first 500 products.</p>' : ''}`;
    }
    ctx.main.innerHTML = `<div class="main-inner">${head}${figures}${tabsBar}${body}</div>`;
    $$('tr.link', ctx.main).forEach((tr) => { tr.onclick = () => window.open(tr.dataset.href, '_blank', 'noopener'); tr.onkeydown = (e) => { if (e.key === 'Enter') window.open(tr.dataset.href, '_blank', 'noopener'); }; });
  };
  function catChange(ch, s) {
    const link = `${s.url}/products/${ch.handle}`;
    if (ch.kind === 'added') return `<li><div class="row"><span class="sev ok">Added</span><span><span class="t">${esc(ch.title)}</span><span class="d">${esc(ch.detail || '')}</span></span><span></span></div></li>`;
    if (ch.kind === 'removed') return `<li><div class="row"><span class="sev">Removed</span><span><span class="t">${esc(ch.title)}</span><span class="d">${esc(ch.detail || '')}</span></span><span></span></div></li>`;
    const fields = (ch.fields || []).map((f) => {
      if (f.field === 'description' && f.diff) {
        const d = f.diff;
        return `<div class="field-change"><b>Description edited</b>${d.removed.length ? `<div class="txt-rm">− ${d.removed.map(esc).join(' ')}</div>` : ''}${d.added.length ? `<div class="txt-add">+ ${d.added.map(esc).join(' ')}</div>` : ''}</div>`;
      }
      const before = f.field === 'price' || f.field === 'sale' ? money(f.before) : esc(String(f.before ?? '—'));
      const after = f.field === 'price' || f.field === 'sale' ? money(f.after) : esc(String(f.after ?? '—'));
      const note = f.note ? ` <span class="pill">${esc(f.note)}</span>` : f.pct ? ` <span class="delta ${f.pct > 0 ? 'up' : 'down'}">${f.pct > 0 ? '+' : ''}${f.pct}%</span>` : '';
      return `<div class="field-change"><b>${esc(f.label)}:</b> ${before} → ${after}${note}</div>`;
    }).join('');
    return `<li><div class="row"><span class="sev warn">Edited</span><span><span class="t"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(ch.title)}</a></span>${fields}</span><span></span></div></li>`;
  }

  // ---------- Safe to publish ----------
  const PUB = { safe: ['Safe to publish', 'healthy'], review: ['Review before publishing', 'warning'], blocked: ["Don't publish yet", 'critical'] };
  const pubPill = (r) => r.status === 'running' ? '<span class="pill running">Checking…</span>'
    : r.status === 'done' ? `<span class="pill ${PUB[r.verdict][1]}">${PUB[r.verdict][0]}</span>`
    : r.status === 'cancelled' ? '<span class="pill">Stopped</span>' : '<span class="pill">Didn\'t finish</span>';
  const DEVICE_PAGE = { home: 'Homepage', product: 'Product page' };

  STORE_PAGES.publish = async (ctx, s) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (ctx.r.a && /^\d+$/.test(ctx.r.a)) return publishDetail(ctx, s, Number(ctx.r.a));
    const d = await api(`/api/stores/${s.id}/releases`);
    if (!ctx.alive()) return;
    const shopify = !s.platform || /shopify/i.test(s.platform);
    const form = `<section class="panel pub-start">
      <div class="pub-intro"><span class="empty-icon">${icon('publish', 22)}</span><div><h2>Check a theme before it goes live</h2>
        <p class="sub">We run your test suite on the draft theme and on your live theme at the same time, compare every check, screenshot and speed measure, and tell you if anything would break.</p></div></div>
      <form id="pubf" novalidate>
        <div class="pub-fields"><div class="field"><label for="purl">Theme preview link</label><input id="purl" name="url" placeholder="https://xxxx.shopifypreview.com" autocomplete="off" required></div>
        <div class="field"><label for="plabel">What changed <span class="muted" style="font-weight:400">(optional)</span></label><input id="plabel" name="label" placeholder="e.g. New Diwali homepage" maxlength="120"></div>
        <button class="btn" type="submit" ${s.active_run_id ? 'disabled title="A test is running"' : ''}>${icon('play', 16)}Start check</button></div>
        <p class="error-msg" id="pub-err" role="alert"></p>
      </form>
      <details class="howto"><summary>Where do I find the preview link?</summary><ol>
        <li>In Shopify admin, open <b>Online Store → Themes</b>.</li>
        <li>Next to the draft theme, open the <b>⋯</b> menu and choose <b>Preview</b>.</li>
        <li>In the preview bar at the bottom, choose <b>Share preview</b> and copy the link.</li></ol>
        <p class="muted">Nothing is published and no orders are placed. The draft theme is only opened in our test browser.</p></details>
      ${shopify ? '' : '<div class="notice"><p>Publish checks work with Shopify themes.</p></div>'}</section>`;
    const list = d.releases.length ? `<section class="panel"><div class="panel-head"><h2>Earlier checks</h2></div>
      <div class="table-wrap flat"><table class="data"><thead><tr><th>Started</th><th>Theme</th><th>Result</th><th>Findings</th><th aria-label="Open"></th></tr></thead><tbody>
      ${d.releases.map((r) => { const c = r.summary?.counts; const th = r.summary?.theme?.draft?.name; return `<tr class="link" data-href="#/s/${s.id}/publish/${r.id}" tabindex="0"><td><span class="cell-main">${time(r.created_at)}</span><div class="cell-sub">${esc(exact(r.created_at))}</div></td>
        <td><span class="cell-main">${esc(th || 'Draft theme')}</span>${r.label ? `<div class="cell-sub">${esc(r.label)}</div>` : ''}</td><td>${pubPill(r)}</td>
        <td class="cell-sub">${c ? [c.blockers && plural(c.blockers, 'break'), c.reviews && plural(c.reviews, 'warning'), c.visual && `${plural(c.visual, 'page')} changed`, c.fixes && `${plural(c.fixes, 'fix', 'fixes')}`].filter(Boolean).join(' · ') || 'No differences' : esc(r.summary?.error || '–')}</td>
        <td class="go">${icon('right', 16)}</td></tr>`; }).join('')}</tbody></table></div></section>` : '';
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Safe to publish')}${form}${list}</div>`;
    $$('tr.link', ctx.main).forEach((tr) => { tr.onclick = () => (location.hash = tr.dataset.href); tr.onkeydown = (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; }; });
    $('#pubf').onsubmit = async (e) => {
      e.preventDefault();
      const url = $('#purl').value.trim();
      if (!url) { $('#pub-err').textContent = 'Paste the theme preview link.'; return; }
      const done = busy(e.target.querySelector('button[type=submit]'), 'Starting');
      try {
        const r = await api(`/api/stores/${s.id}/releases`, { method: 'POST', body: { url, label: $('#plabel').value } });
        location.hash = `#/s/${s.id}/publish/${r.id}`;
      } catch (ex) { done(); $('#pub-err').textContent = ex.message; }
    };
    if (d.releases.some((r) => r.status === 'running')) poll(4000);
  };

  async function publishDetail(ctx, s, rid) {
    const r = await api(`/api/stores/${s.id}/releases/${rid}`);
    if (!ctx.alive()) return;
    const sum = r.summary;
    const crumb = `<a href="#/s/${s.id}/publish">Safe to publish</a> / Check #${r.id}`;
    const title = sum?.theme?.draft?.name || r.label || 'Draft theme';
    const meta = `${r.label && sum?.theme?.draft?.name ? `<span>${esc(r.label)}</span><span class="sep"></span>` : ''}<span>Started ${esc(exact(r.created_at))}</span>${r.finished_at ? `<span class="sep"></span><span>took ${duration(r.created_at, r.finished_at)}</span>` : ''}`;
    const preview = `<a class="icon-btn bordered" href="${esc(r.preview_url)}" target="_blank" rel="noopener" data-tip="Open draft preview" aria-label="Open draft preview">${icon('external', 17)}</a>`;

    if (r.status === 'running') {
      const row = (label, run) => {
        if (!run) return '';
        const st = liveState({ ...run, kind: 'full' });
        const what = run.status === 'done' ? 'Finished' : st.queued ? 'Waiting to start' : `${st.current.label} · step ${st.idx + 1} of ${st.phases.length}`;
        return `<div class="pub-run"><div class="pub-run-head"><b>${esc(label)}</b><span class="muted">${esc(what)}</span>${run.status === 'done' ? `<span class="t-pass">${icon('check', 16)}</span>` : '<span class="spinner"></span>'}</div>
          <div class="progress"><i style="width:${run.status === 'done' ? 100 : st.pct}%"></i></div>${run.live ? `<p class="live-tally">${tally(run.live.counts)}</p>` : ''}</div>`;
      };
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, title, { crumb, meta, actions: preview + `<button type="button" class="btn danger" id="pub-stop">${icon('stop', 16)}Stop</button>` })}
        <section class="panel run-live"><div class="rl-head"><span class="spinner"></span><div><h2>Testing both themes side by side</h2><p>Usually takes 1 to 3 minutes. This page updates by itself.</p></div></div></section>
        <div class="grid-2 run-live-grid"><section class="panel">${row('Live theme', r.runs.live)}</section><section class="panel">${row('Draft theme', r.runs.draft)}</section></div></div>`;
      $('#pub-stop').onclick = async (e) => {
        if (!(await confirmDialog({ title: 'Stop this publish check?', body: 'Both test runs stop and nothing is saved.', confirm: 'Stop check', danger: true }))) return;
        busy(e.currentTarget, 'Stopping');
        await api(`/api/stores/${s.id}/releases/${r.id}/cancel`, { method: 'POST' }).catch(() => {});
        render({ silent: true });
      };
      poll(2500);
      return;
    }
    if (r.status !== 'done') {
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, title, { crumb, meta, actions: preview })}<div class="panel empty"><h2>${r.status === 'cancelled' ? 'This check was stopped' : "This check didn't finish"}</h2><p>${esc(sum?.error || (r.status === 'cancelled' ? 'Nothing was saved.' : 'One of the test runs could not finish. Try again in a few minutes.'))}</p><a class="btn" href="#/s/${s.id}/publish">New publish check</a></div></div>`;
      return;
    }

    const [vLabel, vKey] = PUB[r.verdict];
    const icn = { safe: 'check', review: 'alerts', blocked: 'stop' }[r.verdict];
    const hero = `<section class="panel pub-verdict ${vKey}">
      <span class="pv-icon">${icon(icn, 26)}</span>
      <div class="pv-text"><p class="pv-kicker">${esc(vLabel)}</p><h2>${esc(sum.headline)}</h2>
        <p class="muted">${esc(sum.theme?.draft?.name || 'Draft')} compared with ${esc(sum.theme?.live?.name || 'your live theme')} on desktop, tablet and phone.</p></div>
      <div class="pv-scores"><div><span>Live</span><b>${sum.scores?.live ?? '–'}</b></div><span class="pv-arrow">${icon('arrow', 18)}</span><div><span>Draft</span><b class="${(sum.scores?.draft ?? 0) < (sum.scores?.live ?? 0) - 5 ? 't-fail' : ''}">${sum.scores?.draft ?? '–'}</b></div></div></section>`;
    const findRow = (x, kind) => `<li><div class="row"><span class="sev ${kind === 'fix' ? 'ok' : x.status === 'fail' ? 'fail' : 'warn'}">${kind === 'fix' ? 'Fixed' : x.status === 'fail' ? 'Breaks' : 'Check'}</span>
      <span><span class="t">${esc(x.title)}</span><span class="d">${esc(kind === 'fix' ? `On live: ${x.liveDetail}` : x.detail)}</span>
      ${kind !== 'fix' && x.liveDetail ? `<span class="pub-live">On live: ${esc(x.liveDetail)}</span>` : ''}
      ${kind !== 'fix' && x.fix ? `<div class="fix-line"><b>How to fix:</b> ${esc(x.fix)}</div>` : ''}
      ${x.evidence?.screenshot ? `<div class="evidence"><button type="button" class="btn small secondary" data-shot="${esc(x.evidence.screenshot)}">${icon('image', 14)}Screenshot</button></div>` : ''}</span><span></span></div></li>`;
    const breaks = [...sum.blockers, ...sum.reviews];
    const findings = `<div class="grid-2 tight"><section class="panel"><h2>Breaks or changes on the draft</h2><p class="sub">Works on your live store, but not on the draft.</p>
        ${breaks.length ? `<ul class="list">${breaks.map((x) => findRow(x, 'break')).join('')}</ul>` : `<p class="muted" style="margin:0">Nothing breaks on the draft.</p>`}</section>
      <section class="panel"><h2>Fixed by the draft</h2><p class="sub">Problems on your live store that the draft fixes.</p>
        ${sum.fixes.length ? `<ul class="list">${sum.fixes.map((x) => findRow(x, 'fix')).join('')}</ul>` : `<p class="muted" style="margin:0">No live problems are fixed by the draft.</p>`}</section></div>`;
    const cmp = r.compare || { visual: [], metrics: [], areas: [] };
    const DEV = [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Phone']].filter(([dv]) => cmp.visual.some((v) => v.key.endsWith(dv)));
    const visual = cmp.visual.length ? `<section class="panel"><div class="panel-head"><h2>How the draft looks</h2>
        <div class="seg" role="radiogroup" aria-label="Device">${DEV.map(([dv, l], i) => `<label><input type="radio" name="pdev" value="${dv}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
        <p class="sub">Draft and live screenshots of the same page. Difference shows changed pixels in red.</p><div class="shots" id="pub-shots"></div></section>` : '';
    const metrics = cmp.metrics.length ? `<section class="panel"><h2>Speed and page weight</h2><p class="sub">Phone-sized screen. Changes under 10% are treated as noise.</p>
      <div class="table-wrap flat"><table class="data"><thead><tr><th>Page</th><th>Measure</th><th class="num">Live</th><th class="num">Draft</th><th class="num">Change</th></tr></thead><tbody>
      ${cmp.metrics.map((m) => `<tr><td class="cell-sub">${esc(m.page)}</td><td>${esc(m.name)}</td><td class="num">${fmtVal(m.b, m.unit)}</td><td class="num">${fmtVal(m.a, m.unit)}</td><td class="num"><span class="trend ${m.trend}">${m.trend === 'worse' ? 'Slower' : m.trend === 'better' ? 'Faster' : 'Same'}</span></td></tr>`).join('')}</tbody></table></div></section>` : '';
    const allChecks = cmp.areas.flatMap((a) => a.checks);
    const same = allChecks.filter((x) => x.a === x.b).length;
    const checks = cmp.areas.length ? `<section class="panel"><details class="still"><summary>All ${allChecks.length} checks compared · ${same} unchanged</summary>
      <div class="table-wrap flat" style="margin-top:10px"><table class="data"><thead><tr><th style="width:90px">Live</th><th style="width:90px">Draft</th><th>Check</th></tr></thead><tbody>
      ${allChecks.map((x) => `<tr class="${x.change === 'new' || x.change === 'worse' ? 'row-new' : x.change === 'fixed' ? 'row-fixed' : ''}"><td>${stat(x.b)}</td><td>${stat(x.a)}</td><td><span class="cell-main">${esc(x.title)}</span><div class="cell-sub">${esc(x.detail || x.prevDetail)}</div></td></tr>`).join('')}</tbody></table></div></details></section>` : '';
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, title, { crumb, meta, actions: preview + `<a class="btn secondary" href="#/s/${s.id}/publish">${icon('publish', 16)}New check</a>` })}${hero}${findings}${visual}${metrics}${checks}</div>`;
    $$('[data-shot]', ctx.main).forEach((x) => (x.onclick = () => lightbox(x.dataset.shot, 'Screenshot')));
    const draw = (dv) => {
      $('#pub-shots').innerHTML = cmp.visual.filter((v) => v.key.endsWith(dv)).map((v) => {
        const views = [['a', 'Draft', v.a], ['b', 'Live', v.b], ['diff', 'Difference', v.diff]].filter((x) => x[2]);
        const chip = v.ratio == null ? '' : v.ratio > 5 ? `<span class="pill warning">${v.ratio}% different</span>` : '<span class="pill healthy">Looks the same</span>';
        const pg = DEVICE_PAGE[v.key.split('-')[0]] || v.key;
        return `<article class="shot-card"><header><b>${esc(pg)}</b>${chip}</header>
          ${views.length > 1 ? `<div class="seg" role="radiogroup" aria-label="View">${views.map((x, i) => `<label><input type="radio" name="pv-${v.key}" value="${esc(x[2])}" ${i === 0 ? 'checked' : ''}><span>${x[1]}</span></label>`).join('')}</div>` : ''}
          <div class="frame">${views[0] ? `<img src="${esc(views[0][2])}" alt="${esc(pg)}" loading="lazy">` : '<span class="none">No screenshot</span>'}</div></article>`;
      }).join('');
      $$('#pub-shots .shot-card').forEach((card) => {
        card.addEventListener('change', (e) => { if (e.target.name?.startsWith('pv-')) card.querySelector('.frame img').src = e.target.value; });
        card.querySelector('.frame img')?.addEventListener('click', (e) => lightbox(e.target.src, e.target.alt));
      });
    };
    if (DEV.length) { draw(DEV[0][0]); $$('input[name=pdev]', ctx.main).forEach((x) => (x.onchange = () => draw(x.value))); }
  }

  // ---------- Workspace pages ----------
  const PAGES = {};

  PAGES.home = async (ctx) => {
    ctx.main.innerHTML = `<div class="main-inner welcome">
      <h1>${S.me.name ? `Welcome, ${esc(S.me.name.split(' ')[0])}.` : 'Welcome to Tharam.'} Let's set up your first store.</h1>
      <p class="lede">It takes about two minutes, and nothing runs until you say so.</p>
      <ol>
        <li><b>Find your store.</b> Enter its address and we'll detect the platform, products and collections.</li>
        <li><b>Choose what to test.</b> The shopping journey, speed, SEO, accessibility, broken links and visual changes, all switchable.</li>
        <li><b>Choose how often and where alerts go.</b> Email or Slack, only when something breaks or recovers.</li>
        <li><b>Run the first check.</b> See your store's health in about two minutes. Scheduled monitoring starts after it.</li>
      </ol>
      <a class="btn" href="#/add" style="margin-top:12px">Add your store</a></div>`;
  };

  PAGES.stores = async (ctx) => {
    const d = await api('/api/overview');
    if (!ctx.alive()) return;
    if (!d.stores.length) return PAGES.home(ctx);
    ctx.main.innerHTML = `<div class="main-inner"><div class="page-head"><div><div class="crumbs">Workspace</div><h1>All stores</h1><div class="meta">${d.stores.length} of 5 stores in the beta</div></div><div class="actions"><a class="btn" href="#/add">${icon('add', 16)}Add a store</a></div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Store</th><th>Status</th><th class="num">Buyability, 7 days</th><th class="num">Health</th><th>Last test</th><th>Next test</th><th aria-label="Open"></th></tr></thead><tbody>
      ${d.stores.map((s) => { const st = storeStatus(s); return `<tr class="link" data-href="#/s/${s.id}" tabindex="0"><td><div class="cell-main">${esc(s.name || host(s.url))}</div><div class="cell-sub">${esc(host(s.url))}${s.platform ? ` · ${esc(s.platform)}` : ''}</div></td>
        <td><span class="status-inline"><span class="dot ${esc(st.key)}"></span>${esc(st.label)}</span>${s.failing.length ? `<div class="cell-sub">${s.failing.length} open problem${s.failing.length > 1 ? 's' : ''}</div>` : ''}</td>
        <td class="num"><b>${s.buyability_week == null ? '–' : s.buyability_week + '%'}</b></td><td class="num">${s.last_score ?? '–'}</td><td>${s.last_run_at ? time(s.last_run_at) : '<span class="muted">Not yet</span>'}</td><td class="cell-sub">${s.active_run_id ? 'Running now' : s.monitoring && s.last_run_at ? esc(inMin(s.next_run_in)) : s.monitoring ? 'After first check' : 'Paused'}</td><td class="go">${icon('right', 16)}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${d.alerts.length ? `<section class="panel" style="margin-top:20px"><h2>Latest alerts across stores</h2><ul class="list" style="margin-top:10px">${d.alerts.slice(0, 8).map((a) => `<li><a class="row" href="#/s/${a.store_id}/alerts"><span class="sev ${a.state === 'failing' ? 'fail' : 'ok'}">${a.state === 'failing' ? 'Broke' : 'Fixed'}</span><span><span class="t">${esc(a.store_name || host(a.store_url))}</span><span class="d">${esc(a.message || a.check_id)}</span></span><span class="r">${time(a.created_at)}</span></a></li>`).join('')}</ul></section>` : ''}</div>`;
    $$('tr.link', ctx.main).forEach((tr) => { tr.onclick = () => (location.hash = tr.dataset.href); tr.onkeydown = (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; }; });
    if (d.stores.some((s) => s.active_run_id)) poll(5000);
  };

  PAGES.account = async (ctx) => {
    const tab = ctx.r.a === 'password' ? 'password' : null;
    const head = `<div class="page-head"><div><div class="crumbs">Workspace</div><h1>Account</h1><div class="meta">${esc(S.me.email)}</div></div></div>` + tabs('#/account', [[null, 'Profile'], ['password', 'Password']], tab);
    if (tab === 'password') {
      ctx.main.innerHTML = `<div class="main-inner">${head}<form class="settings-card" id="pwf"><div class="form-section"><div><h3>Change password</h3><p class="explain">Use at least 8 characters. You'll stay logged in on this device.</p></div>
        <div class="controls"><div class="field"><label for="cur">Current password</label><input id="cur" name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="nx">New password</label><input id="nx" name="next" type="password" autocomplete="new-password" minlength="8" required></div>
        <div><button class="btn" type="submit">Change password</button></div><p class="error-msg" id="pw-err" role="alert"></p></div></div></form></div>`;
      $('#pwf').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        const done = busy(e.target.querySelector('button'), 'Changing');
        try { await api('/api/account/password', { method: 'POST', body: fd }); e.target.reset(); toast('Password changed'); $('#pw-err').textContent = ''; }
        catch (ex) { $('#pw-err').textContent = ex.message; } finally { done(); }
      };
      return;
    }
    ctx.main.innerHTML = `<div class="main-inner">${head}<form class="settings-card" id="prof">
      <div class="form-section"><div><h3>Profile</h3><p class="explain">Your name appears in emails from us.</p></div>
        <div class="controls"><div class="field"><label for="pn">Name</label><input id="pn" name="name" value="${esc(S.me.name || '')}" autocomplete="name"></div>
        <div class="field"><label for="pe">Email</label><input id="pe" value="${esc(S.me.email)}" readonly><p class="hint">To change your login email, write to hello@tharam.store.</p></div></div></div>
      <div class="form-section"><div><h3>Plan</h3><p class="explain">Store Guard is free during the beta. We'll give at least 30 days' notice before any charge, and beta users keep a founding discount.</p></div>
        <div class="controls"><div><span class="pill healthy">Beta · free</span></div><p class="muted" style="margin:0">Up to 5 stores, journey tests as often as hourly, daily full checks.</p></div></div></form></div>`;
    const form = $('#prof');
    const mark = savebar($('.main-inner', ctx.main), {
      onSave: async () => { await api('/api/account', { method: 'PATCH', body: { name: new FormData(form).get('name') } }); S.me = (await api('/api/me')).user; },
      onDiscard: () => render(),
    });
    form.addEventListener('input', mark);
  };

  PAGES.admin = async (ctx) => {
    if (!S.admin) { location.hash = '#/'; return; }
    const d = await api('/api/admin/overview');
    if (!ctx.alive()) return;
    const t = (rows, cols, map = (r, c) => esc(r[c] ?? '')) => rows.length ? `<div class="table-wrap"><table class="data"><thead><tr>${cols.map((c) => `<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${map(r, c[0])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing yet.</p>';
    ctx.main.innerHTML = `<div class="main-inner"><div class="page-head"><div><div class="crumbs">Workspace</div><h1>Founder view</h1><div class="meta">Only visible to ${esc(S.me.email)}</div></div></div>
      <div class="figures" style="grid-template-columns:repeat(4,minmax(0,1fr))"><div class="figure"><b>${d.users}</b><span>accounts</span></div><div class="figure"><b>${d.stores}</b><span>stores added</span></div><div class="figure"><b>${d.freeScans24h}</b><span>free checks, 24 h</span></div><div class="figure"><b>${d.queue.active} / ${d.queue.waiting}</b><span>running / waiting</span></div></div>
      <section class="panel"><h2>Signups</h2>${t(d.signups, [['email', 'Email'], ['name', 'Name'], ['stores', 'Stores'], ['created_at', 'Joined']], (r, c) => (c === 'created_at' ? time(r[c]) : esc(r[c] ?? '')))}</section>
      <section class="panel"><h2>Leads</h2>${t(d.leads, [['email', 'Email'], ['store_url', 'Store'], ['source', 'Source'], ['created_at', 'When']], (r, c) => (c === 'created_at' ? time(r[c]) : esc(r[c] ?? '')))}</section>
      <section class="panel"><h2>Free checks</h2>${t(d.recentScans, [['url', 'Store'], ['score', 'Score'], ['verdict', 'Result'], ['created_at', 'When'], ['id', 'Report']], (r, c) => (c === 'created_at' ? time(r[c]) : c === 'id' ? `<a href="/scan/${r.id}" target="_blank" rel="noopener">Open</a>` : c === 'verdict' ? esc(VERDICT[r.verdict] || r.status) : esc(r[c] ?? '')))}</section></div>`;
  };

  // ---------- Add a store (setup) ----------
  PAGES.add = async (ctx) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (!ctx.alive()) return;
    if (!S.wizard) S.wizard = { step: 1, url: '', password: '', locked: false, found: null, disabled: [], testProduct: '', journeyIntervalMin: S.catalog.defaults.journeyIntervalMin, fullIntervalMin: S.catalog.defaults.fullIntervalMin, alertEmail: S.me.email, slack: '', monitoring: true };
    if (S.stores.length >= 5) {
      ctx.main.innerHTML = `<div class="main-inner narrow-page"><div class="page-head"><div><div class="crumbs">Workspace</div><h1>Add a store</h1></div></div><div class="panel empty"><h2>You've reached the beta limit</h2><p>The beta includes up to 5 stores. Remove one in its settings, or write to hello@tharam.store if you need more.</p><a class="btn secondary" href="#/stores">See all stores</a></div></div>`;
      return;
    }
    wizardStep(ctx);
  };

  function wizardStep(ctx) {
    const w = S.wizard;
    const names = ['Find your store', 'Choose tests', 'Schedule and alerts', 'Review'];
    const stepper = `<ol class="stepper">${names.map((n, i) => `<li class="${i + 1 < w.step ? 'done' : i + 1 === w.step ? 'current' : ''}" ${i + 1 === w.step ? 'aria-current="step"' : ''}><span>${n}</span></li>`).join('')}</ol>`;
    const wrap = (inner) => {
      ctx.main.innerHTML = `<div class="main-inner narrow-page"><div class="page-head"><div><div class="crumbs">Workspace</div><h1>Add a store</h1><div class="meta">Step ${w.step} of 4 · nothing runs until you finish</div></div>${w.step > 1 ? '<div class="actions"><button class="btn link" type="button" id="restart">Start over</button></div>' : ''}</div>${stepper}<div class="panel wiz-card">${inner}</div></div>`;
      const r = $('#restart');
      if (r) r.onclick = () => { S.wizard = null; render(); };
    };
    const shopify = w.found?.isShopify || w.found?.blocked;

    if (w.step === 1) {
      wrap(`<form id="w1" novalidate>
        <div class="field"><label for="wurl">Store address</label><input id="wurl" name="url" placeholder="yourstore.com" value="${esc(w.url)}" inputmode="url" autocomplete="url" required><p class="hint">Your public store address, or your .myshopify.com address.</p></div>
        <label class="toggle-line" style="margin-top:18px"><span class="switch"><input type="checkbox" id="haspw" ${w.locked || w.password ? 'checked' : ''}><span></span></span><span class="tl-text"><b>My store is password protected</b><span>Common before launch. We need the storefront password to test it.</span></span></label>
        <div class="field" id="pwfield" style="margin-top:14px" ${w.locked || w.password ? '' : 'hidden'}><label for="wpw">Storefront password</label><input id="wpw" name="password" type="password" autocomplete="off" value="${esc(w.password)}"></div>
        <p class="error-msg" id="w-err" role="alert"></p>
        <div id="looking"></div>
        <div class="wiz-actions"><a class="btn link" href="${S.stores.length ? '#/stores' : '#/'}">Cancel</a><div class="right"><button class="btn" type="submit">Find my store</button></div></div></form>`);
      $('#haspw').onchange = (e) => { $('#pwfield').hidden = !e.target.checked; if (e.target.checked) $('#wpw').focus(); };
      $('#wurl').focus();
      $('#w1').onsubmit = async (e) => {
        e.preventDefault();
        w.url = $('#wurl').value.trim();
        w.password = $('#haspw').checked ? $('#wpw').value : '';
        $('#w-err').textContent = '';
        if (!w.url) { $('#w-err').textContent = 'Enter your store address, like yourstore.com'; return; }
        const btn = e.target.querySelector('button[type=submit]');
        const done = busy(btn, 'Looking at your store');
        $('#looking').innerHTML = `<div class="panel looking" style="margin-top:20px" aria-live="polite"><div class="stage"><span class="spinner"></span>Opening ${esc(w.url.replace(/^https?:\/\//, ''))} in a real browser</div><div class="stage"><span class="spinner" style="opacity:.6"></span>Detecting the platform</div><div class="stage"><span class="spinner" style="opacity:.35"></span>Reading products and collections</div><p class="muted" style="margin:4px 0 0;font-size:.9rem">Usually takes 5 to 20 seconds.</p></div>`;
        try {
          const d = await api('/api/discover', { method: 'POST', body: { url: w.url, password: w.password || undefined } });
          $('#looking').innerHTML = '';
          if (!d.reachable && !d.locked) { done(); $('#w-err').textContent = d.error || `We couldn't open ${host(d.origin)} (status ${d.status}). Check the address.`; return; }
          if (d.locked) {
            done();
            w.locked = true;
            $('#haspw').checked = true; $('#pwfield').hidden = false;
            $('#w-err').textContent = d.wrongPassword ? 'That storefront password didn\'t work. Check it and try again.' : 'This store is password protected. Enter the storefront password to continue.';
            $('#wpw').focus();
            return;
          }
          w.found = d;
          w.url = d.origin;
          w.testProduct = '';
          w.disabled = d.isShopify || d.blocked ? [] : S.catalog.groups.filter((g) => g.key.startsWith('journey.') && !g.locked).map((g) => g.key);
          w.step = 2;
          wizardStep(ctx);
        } catch (ex) { done(); $('#looking').innerHTML = ''; $('#w-err').textContent = ex.message; }
      };
      return;
    }

    const f = w.found;
    const foundCard = `<dl class="found"><div><dt>Store</dt><dd>${esc(host(f.origin))}</dd></div><div><dt>Platform</dt><dd>${esc(f.platform?.label || 'Unknown')}</dd></div><div><dt>Catalog</dt><dd>${f.productCount ? `${f.productCount >= 50 ? '50+' : f.productCount} products` : 'Not readable'}${f.collections?.length ? ` · ${f.collections.length}${f.collections.length >= 3 ? '+' : ''} collections` : ''}</dd></div></dl>`;

    if (w.step === 2) {
      wrap(`${foundCard}
        ${f.blocked ? `<div class="notice"><p><b>${esc(f.blockedBy)} asked our test browser to verify itself.</b> You can still add the store, but tests will show as blocked until Tharam is allowed in. ${f.blockedBy === 'Cloudflare' ? 'In Cloudflare, add a WAF custom rule that skips bot protection when the User Agent contains “TharamStoreGuard”.' : 'Write to hello@tharam.store and we will help you allow it.'}</p></div>` : ''}
        ${shopify || f.blocked ? '' : `<div class="notice info"><p>${esc(f.platform?.label || 'This platform')} is detected. Add to cart and checkout tests run on Shopify today; speed, SEO, accessibility, links and errors are fully tested.</p></div>`}
        <form id="w2">
        ${shopify && f.catalog?.length ? `<div class="field" style="margin-bottom:28px"><label for="wtp">Product used in tests</label><select id="wtp"><option value="">Choose automatically (recommended)</option>${f.catalog.map((p) => `<option value="${esc(p.handle)}" ${p.handle === w.testProduct ? 'selected' : ''}>${esc(p.title)}${p.variants > 1 ? ` (${p.variants} variants)` : ''}</option>`).join('')}</select><p class="hint">Each test adds one to a fresh cart, opens checkout, then empties the cart. No orders are created.</p></div>` : ''}
        ${suiteRows(S.catalog.groups, w.disabled, { shopify, aiEnabled: S.catalog.aiEnabled })}
        <div class="wiz-actions"><button class="btn secondary" type="button" id="back">Back</button><div class="right"><button class="btn" type="submit">Continue</button></div></div></form>`);
      const form = $('#w2');
      form.addEventListener('change', (e) => e.target.name === 'g' && e.target.closest('.check-row')?.classList.toggle('off', !e.target.checked));
      const save = () => { w.disabled = readDisabled(form).concat(shopify ? [] : S.catalog.groups.filter((g) => g.key.startsWith('journey.') && !g.locked).map((g) => g.key)); w.testProduct = $('#wtp')?.value || ''; };
      $('#back').onclick = () => { save(); w.step = 1; wizardStep(ctx); };
      form.onsubmit = (e) => { e.preventDefault(); save(); w.step = 3; wizardStep(ctx); };
      return;
    }

    if (w.step === 3) {
      const radios = (name, map, val) => `<div class="seg" role="radiogroup">${Object.entries(map).map(([k, l]) => `<label><input type="radio" name="${name}" value="${k}" ${Number(k) === val ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
      wrap(`<form class="settings-card" id="w3" novalidate>
        <div class="form-section"><div><h3>Journey tests</h3><p class="explain">How often we shop your store. If a test fails, we re-test every 30 minutes until it's fixed.</p></div><div class="controls">${radios('journeyIntervalMin', EVERY, w.journeyIntervalMin)}</div></div>
        <div class="form-section"><div><h3>Full check</h3><p class="explain">The journey plus speed, SEO, accessibility, links, catalog and visual changes.</p></div><div class="controls">${radios('fullIntervalMin', FULL_EVERY, w.fullIntervalMin)}</div></div>
        <div class="form-section"><div><h3>Alerts</h3><p class="explain">We alert once when something breaks and once when it recovers.</p></div>
          <div class="controls"><div class="field"><label for="wae">Email</label><input id="wae" name="alertEmail" type="email" value="${esc(w.alertEmail)}" required></div>
          <div class="field"><label for="wsl">Slack webhook URL <span class="muted" style="font-weight:400">(optional)</span></label><input id="wsl" name="slack" value="${esc(w.slack)}" placeholder="https://hooks.slack.com/services/…"><p class="hint">You can add this later under Alerts.</p></div></div></div>
        <div class="form-section"><div><h3>Monitoring</h3><p class="explain">You can pause monitoring at any time.</p></div>
          <div class="controls"><label class="toggle-line"><span class="switch"><input type="checkbox" name="monitoring" ${w.monitoring ? 'checked' : ''}><span></span></span><span class="tl-text"><b>Start monitoring after the first check</b><span>Off means only checks you start will run.</span></span></label></div></div>
        <p class="error-msg" id="w-err" role="alert"></p>
        <div class="wiz-actions"><button class="btn secondary" type="button" id="back">Back</button><div class="right"><button class="btn" type="submit">Review</button></div></div></form>`);
      const form = $('#w3');
      const save = () => { const fd = new FormData(form); w.journeyIntervalMin = Number(fd.get('journeyIntervalMin')); w.fullIntervalMin = Number(fd.get('fullIntervalMin')); w.alertEmail = String(fd.get('alertEmail')).trim(); w.slack = String(fd.get('slack')).trim(); w.monitoring = !!fd.get('monitoring'); };
      $('#back').onclick = () => { save(); w.step = 2; wizardStep(ctx); };
      form.onsubmit = (e) => {
        e.preventDefault(); save();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(w.alertEmail)) { $('#w-err').textContent = 'Enter a valid alert email'; return; }
        if (w.slack && !/^https:\/\/hooks\.slack\.com\//.test(w.slack)) { $('#w-err').textContent = 'Slack webhook URLs start with https://hooks.slack.com/'; return; }
        w.step = 4; wizardStep(ctx);
      };
      return;
    }

    const groups = S.catalog.groups;
    const onCount = groups.filter((g) => !w.disabled.includes(g.key)).length;
    const off = groups.filter((g) => w.disabled.includes(g.key)).map((g) => g.label);
    const tp = w.testProduct ? f.catalog.find((p) => p.handle === w.testProduct)?.title || w.testProduct : 'Chosen automatically';
    const row = (label, value, step) => `<tr><th scope="row">${label}</th><td>${value}</td><td class="edit"><button class="btn link" type="button" data-go="${step}">Edit</button></td></tr>`;
    wrap(`<table class="review"><tbody>
      ${row('Store', `${esc(host(f.origin))}<div class="cell-sub">${esc(f.platform?.label || '')}${w.password ? ' · password saved' : ''}</div>`, 1)}
      ${row('Checks', `${onCount} of ${groups.length} switched on${off.length ? `<div class="cell-sub">Off: ${esc(off.join(', '))}</div>` : ''}`, 2)}
      ${shopify ? row('Test product', esc(tp), 2) : ''}
      ${row('Journey tests', esc(EVERY[w.journeyIntervalMin]), 3)}
      ${row('Full check', esc(FULL_EVERY[w.fullIntervalMin]), 3)}
      ${row('Alerts', `${esc(w.alertEmail)}${w.slack ? '<div class="cell-sub">and Slack</div>' : ''}`, 3)}
      ${row('Monitoring', w.monitoring ? 'Starts after the first check' : 'Off: only checks you start', 3)}
    </tbody></table>
    <p class="muted" style="margin-top:16px">The first check takes 1 to 3 minutes. Tests behave like one shopper and stop before payment, so no orders are created.</p>
    <p class="error-msg" id="w-err" role="alert"></p>
    <div class="wiz-actions"><button class="btn secondary" type="button" id="back">Back</button><div class="right"><button class="btn secondary" type="button" id="save-only">Save without running</button><button class="btn" type="button" id="save-run">Save and run first check</button></div></div>`);
    $$('[data-go]').forEach((b) => (b.onclick = () => { w.step = Number(b.dataset.go); wizardStep(ctx); }));
    $('#back').onclick = () => { w.step = 3; wizardStep(ctx); };
    const submit = async (runNow, btn) => {
      const done = busy(btn, runNow ? 'Saving and starting' : 'Saving');
      try {
        const r = await api('/api/stores', { method: 'POST', body: { url: w.url, name: host(w.url), password: w.password || undefined, alertEmail: w.alertEmail, slack: w.slack || undefined, monitoring: w.monitoring, runNow, platform: f.platform?.label, config: { disabled: w.disabled, testProduct: w.testProduct || null, journeyIntervalMin: w.journeyIntervalMin, fullIntervalMin: w.fullIntervalMin } } });
        S.wizard = null;
        toast(runNow ? 'Store added. First check started.' : 'Store added');
        location.hash = `#/s/${r.id}`;
      } catch (ex) { done(); $('#w-err').textContent = ex.message; }
    };
    $('#save-run').onclick = (e) => submit(true, e.currentTarget);
    $('#save-only').onclick = (e) => submit(false, e.currentTarget);
  }

  // ---------- Boot ----------
  async function boot() {
    try { const r = await api('/api/me'); S.me = r.user; S.admin = r.admin; }
    catch { return authView(location.hash === '#signup' ? 'signup' : 'login'); }
    shell();
    if (location.hash === '#signup') location.replace('#/');
    render();
  }
  boot();
})();
