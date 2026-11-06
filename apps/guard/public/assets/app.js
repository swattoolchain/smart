/* Tharam Store Guard app. Every screen is a URL (#/...), so refreshing or live updates never lose your place. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.escHtml;

  const S = { me: null, admin: false, stores: [], catalog: null, storeId: null, dirty: false, wizard: null, token: 0, timer: null, route: '', stopping: new Set(), focus: null };

  // ---------- Helpers ----------
  // Inside Shopify admin (the Shopify app) there are no cookies: each request carries a fresh Shopify session token.
  const EMB = !!window.THARAM_EMBEDDED;
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (EMB) headers.Authorization = `Bearer ${await window.shopify.idToken()}`;
    const r = await fetch(path, { headers, credentials: 'same-origin', ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && EMB) throw Object.assign(new Error(j.error || 'Reload the page to continue.'), { status: 401 });
    if (r.status === 401 && !path.startsWith('/api/auth')) { S.me = null; authView('login'); throw new Error('Please log in'); }
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong. Try again.'), { status: r.status, problems: j.problems });
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
  const EVERY = { 30: 'Every 30 minutes', 60: 'Every hour', 180: 'Every 3 hours', 360: 'Every 6 hours', 720: 'Every 12 hours', 1440: 'Once a day' };
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
  /** A small form in a dialog. onSubmit(form) may throw a readable error; resolves with its result or null. */
  function formDialog({ title, body, submit, onSubmit, wide, onOpen, cancel = 'Cancel' }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = `confirm form-dialog${wide ? ' wide' : ''}`;
      d.innerHTML = `<form novalidate><div class="fd-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('close', 18)}</button></div>${body}
        <p class="error-msg" role="alert"></p><div class="row">${cancel ? `<button type="button" class="btn secondary" data-close>${esc(cancel)}</button>` : ''}${submit ? `<button type="submit" class="btn">${esc(submit)}</button>` : ''}</div></form>`;
      document.body.appendChild(d);
      let result = null;
      const f = d.querySelector('form');
      d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector('button[type=submit]');
        const done = busy(btn, 'Saving');
        try { result = await onSubmit(f); d.close(); } catch (ex) { done(); f.querySelector('.error-msg').textContent = ex.message; }
      };
      d.addEventListener('close', () => { resolve(result); d.remove(); });
      d.showModal();
      if (onOpen) onOpen(d);
      (f.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox])') || f.querySelector('button')).focus();
    });
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select the text and copy it', 'error'); }
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
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
    trash: '<path d="M4.5 7h15M10 11v6M14 11v6"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12M9.5 7V4.5h5V7"/>',
    edit: '<path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-4-4l-10 10z"/><path d="m13.5 6.5 4 4"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/>',
  };
  const icon = (k, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  // ---------- Auth ----------
  function authView(mode, notice) {
    clearTimeout(S.timer);
    if (mode === 'link') return linkView(notice);
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
          <p class="error-msg" id="auth-err" role="alert">${esc(notice || '')}</p>
        </form>
        ${mode === 'signup' ? '' : '<p class="switch-mode"><button type="button" data-m="link">Email me a sign-in link instead</button></p>'}
        <p class="switch-mode">${mode === 'signup' ? 'Already have an account? <button type="button" data-m="login">Log in</button>' : 'New to Tharam? <button type="button" data-m="signup">Create an account</button>'}</p>
      </div></main></div>`;
    $$('[data-m]').forEach((b) => (b.onclick = (e) => authView(e.target.dataset.m)));
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

  // Sign in with an emailed link: for stores that installed from Shopify, or anyone who prefers it.
  function linkView(notice) {
    authView('login');
    const card = $('.auth-card');
    card.innerHTML = `<h1>Email me a sign-in link</h1>
      <p class="sub">We'll email a link that signs you in. It works once, for 30 minutes.</p>
      <form id="lnk" novalidate>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
        <button class="btn block" type="submit">Send the link</button>
        <p class="error-msg" id="auth-err" role="alert">${esc(notice || '')}</p>
      </form>
      <p class="hint" style="margin-top:14px">Installed Tharam from Shopify? Open it from your Shopify admin, or use the email you added there under Account.</p>
      <p class="switch-mode"><button type="button" data-m="login">Log in with a password</button></p>`;
    $('[data-m]', card).onclick = () => authView('login');
    $('#lnk').onsubmit = async (e) => {
      e.preventDefault();
      const email = new FormData(e.target).get('email');
      const done = busy(e.target.querySelector('button'), 'Sending');
      try {
        await api('/api/auth/link', { method: 'POST', body: { email } });
        card.innerHTML = `<h1>Check your email</h1><p class="sub">If <b>${esc(email)}</b> has a Tharam account, a sign-in link is on its way. It works once, for 30 minutes.</p>
          <p class="switch-mode"><button type="button" data-m="link">Send another link</button> · <button type="button" data-m="login">Log in with a password</button></p>`;
        $$('[data-m]', card).forEach((b) => (b.onclick = () => authView(b.dataset.m)));
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
    // Shopify's App Bridge reads its nav menu from the page, so keep it when the shell is drawn.
    const navMenu = document.querySelector('ui-nav-menu');
    document.body.className = 'app' + (EMB ? ' embedded' : '') + (railPref() ? ' rail-collapsed' : '');
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
                <a href="#/account/billing" role="menuitem">${icon('reports', 16)}Plan and billing</a>
                ${S.admin ? `<a href="#/admin" role="menuitem">${icon('founder', 16)}Founder console</a>` : ''}
                <hr><button type="button" id="logout" role="menuitem">${icon('logout', 16)}Log out</button>
              </div>
            </div>
          </header>
          <div id="plan-banner"></div>
          <main class="main" id="main" tabindex="-1"></main>
        </div>
      </div>`;
    if (navMenu) document.body.prepend(navMenu);
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
      ${item(`${base}/tests`, 'code', 'Your tests', at('tests'))}
      ${item(`${base}/monitoring`, 'monitoring', 'Monitoring', at('monitoring'))}
      ${item(`${base}/settings`, 'settings', 'Store settings', at('settings'))}` : ''}
      <div class="rail-label">Workspace</div>
      ${item('#/stores', 'stores', 'All stores', active.page === 'stores')}
      ${S.license?.shopify ? '' : item('#/add', 'add', 'Add a store', active.page === 'add')}
      ${item('#/guide', 'book', 'How to use Tharam', active.page === 'guide')}
      ${S.admin ? item('#/admin', 'founder', 'Founder console', active.page === 'admin') : ''}`;
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
          <hr><a href="#/stores">${icon('stores', 16)}All stores</a>${S.license?.shopify ? '' : `<a href="#/add">${icon('add', 16)}Add a store</a>`}
        </div></div>`;
      const sw = $('#sw-btn');
      sw.onclick = (e) => { e.stopPropagation(); const p = $('#sw-pop'); const open = p.hidden; closePops(); p.hidden = !open; sw.setAttribute('aria-expanded', String(open)); };
    }
    $$('#side a').forEach((a) => a.addEventListener('click', () => document.body.classList.remove('nav-open')));
  }

  // ---------- Router ----------
  async function loadStores() {
    const d = await api('/api/stores');
    S.stores = d.stores;
    S.license = d.license;
  }
  function parseRoute(hash) {
    const h = hash.replace(/^#/, '').split('?')[0] || '/';
    let m;
    if ((m = /^\/s\/(\d+)(?:\/([a-z]+))?(?:\/([\w-]+))?(?:\/([\w-]+))?$/.exec(h))) return { store: Number(m[1]), module: m[2] || 'overview', a: m[3] || null, b: m[4] || null };
    if ((m = /^\/account(?:\/(password|billing))?$/.exec(h))) return { page: 'account', a: m[1] || null };
    if (h === '/stores') return { page: 'stores' };
    if (h === '/add') return { page: 'add' };
    if (h === '/guide') return { page: 'guide' };
    if ((m = /^\/admin(?:\/([a-z]+))?(?:\/(\d+))?$/.exec(h))) return { page: 'admin', a: m[1] || null, b: m[2] ? Number(m[2]) : null };
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
        // A store that hasn't been through the welcome flow starts there.
        const st = S.stores.find((x) => x.id === r.store);
        if (st.config.onboarded === false && r.module !== 'welcome') { location.replace(`#/s/${st.id}/welcome`); return; }
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
      planBanner();
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
  // ---------- Plan awareness. The server enforces everything; this only explains it. ----------
  // Check intervals the plan doesn't include are shown but can't be chosen.
  const belowPlan = (name, k) => !!S.license && ((name === 'journeyIntervalMin' && Number(k) < S.license.limits.journeyMinInterval) || (name === 'fullIntervalMin' && Number(k) < S.license.limits.fullMinInterval));
  const can = (f) => !!S.license?.usable && S.license.features.includes(f);
  const featureOf = (group) => S.catalog?.features?.find((f) => f.groups.includes(group))?.key || null;
  const groupAllowed = (g) => { const f = featureOf(g.key); return !f || can(f); };
  const plansFor = (f) => S.catalog?.features?.find((x) => x.key === f)?.plans || 'a higher';
  const minorMoney = (minor, cur) => { try { return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${cur}`; } };
  // Plan and sale dates are calendar dates (stored as the end of that day, UTC): show that same date everywhere.
  const dateOnly = (sql) => new Date(sql.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  /** A panel that explains a feature isn't in the plan, and how to get it. */
  function upsell(f, title, body) {
    return `<section class="panel upsell"><span class="up-ic">${icon('lock', 20)}</span><div><h2>${esc(title)}</h2><p>${esc(body)}</p>
      <p class="muted" style="margin:6px 0 0">Included in the ${esc(plansFor(f))} plan${/ and /.test(plansFor(f)) ? 's' : ''}.</p></div>
      <div class="up-actions"><a class="btn" href="#/account/billing">See plans</a></div></section>`;
  }
  const storesFull = () => !!S.license && (!S.license.usable || S.license.storesUsed >= S.license.maxStores);
  const addStoreBtn = () => S.license?.shopify ? '' : storesFull()
    ? `<a class="btn secondary" href="#/account/billing" title="${S.license.usable ? 'All stores on your plan are in use' : 'Your plan is not active'}">${icon('lock', 16)}Add a store</a>`
    : `<a class="btn" href="#/add">${icon('add', 16)}Add a store</a>`;
  function planBanner() {
    const el = $('#plan-banner');
    const L = S.license;
    if (!el || !L) return;
    const railPlan = $('.rail .plan');
    if (railPlan) railPlan.innerHTML = `<a href="#/account/billing">${esc(L.plan.name)}${L.state === 'trial' && L.daysLeft != null ? ` · ${L.daysLeft} days left` : ''}</a>`;
    let msg = null, tone = 'warn';
    if (L.state === 'trial' && L.daysLeft != null && L.daysLeft <= 7) msg = `Your free trial ends ${L.daysLeft <= 1 ? 'tomorrow' : `in ${L.daysLeft} days`}. Choose a plan to keep your stores checked.`;
    else if (L.state === 'active' && L.plan.kind === 'paid' && L.daysLeft != null && L.daysLeft <= 7) msg = `Your ${L.plan.name} plan renews ${L.daysLeft <= 1 ? 'tomorrow' : `in ${L.daysLeft} days`}. Pay before then to avoid a gap.`;
    else if (L.state === 'grace') msg = `Your plan expired on ${dateOnly(L.expires_at)}. Checks continue until ${dateOnly(L.graceEnds)}. Renew to keep them running.`;
    else if (L.state === 'expired') { tone = 'fail'; msg = L.status === 'trial' ? 'Your free trial has ended. Checks and alerts have stopped; your reports are kept.' : 'Your plan has expired. Checks and alerts have stopped; your reports are kept.'; }
    else if (L.state === 'suspended') { tone = 'fail'; msg = 'Your account is paused. Checks and alerts have stopped. Contact us to turn it back on.'; }
    else if (L.state === 'cancelled') { tone = 'fail'; msg = 'Your plan has ended. Your reports are kept. Choose a plan to start again.'; }
    el.className = msg ? `plan-banner ${tone}` : '';
    el.innerHTML = msg ? `<span>${icon(tone === 'fail' ? 'stop' : 'alerts', 16)}${esc(msg)}</span><a class="btn small ${tone === 'fail' ? '' : 'secondary'}" href="#/account/billing">${L.state === 'suspended' ? 'Contact us' : 'See your plan'}</a>` : '';
  }

  function storeHead(s, title, { actions = '', crumb = '', meta = '' } = {}) {
    const name = esc(s.name || host(s.url));
    return `<div class="page-head"><div><div class="crumbs">${crumb || `<a href="#/s/${s.id}">${name}</a>`}</div><h1>${esc(title)}</h1>${meta ? `<div class="meta">${meta}</div>` : ''}</div>
      ${actions ? `<div class="actions">${actions}</div>` : ''}</div>${s.blocked ? `<div class="notice warn-n"><p>${icon('lock', 16)} ${esc(s.blocked)} <a href="#/account/billing">See your plan</a></p></div>` : s.config?.saleUntil ? `<div class="notice sale-n"><p><b>Sale mode</b> is on until ${esc(dateOnly(s.config.saleUntil + ' 23:59:59'))}: shopping checks every 30 minutes and a full check every 6 hours${s.config.discountCodes?.length ? `, including your ${s.config.discountCodes.length === 1 ? 'discount code' : 'discount codes'}` : ''}.</p></div>` : ''}`;
  }
  const openStore = (s) => `<a class="icon-btn bordered" href="${esc(s.url)}" target="_blank" rel="noopener" data-tip="Open store" aria-label="Open store in a new tab">${icon('external', 17)}</a>`;
  // Every way of starting a test goes through the Run validations page, so nothing starts without a preview.
  const runLink = (s, label = 'Run validations', cls = 'btn') => `<a class="${cls}" href="#/s/${s.id}/run">${label}</a>`;
  function runButtons(s) {
    if (s.active_run_id) return `<a class="btn secondary" href="#/s/${s.id}/runs/${s.active_run_id}"><span class="pulse" aria-hidden="true"></span>View running test</a>`;
    if (s.blocked) return `<button class="btn" type="button" disabled title="${esc(s.blocked)}">${icon('play', 16)}Run validations</button>`;
    return `<a class="btn" data-tour="run" href="#/s/${s.id}/run">${icon('play', 16)}Run validations</a>`;
  }
  function bindRunButtons() {} // Stop buttons are handled by one listener below.
  const kindLabel = (r) => (r.trigger === 'manual' ? 'Validation run' : r.trigger === 'release' ? 'Publish check' : KIND[r.kind] || 'Run');

  // What a run does, in order. Mirrors src/live.js on the server.
  const PHASES = [
    { key: 'open', label: 'Open your store', sub: 'On a desktop and a phone-sized screen' },
    { key: 'journey', label: 'Shop like a customer', groups: ['journey.core', 'journey.collection', 'journey.search', 'journey.variant', 'journey.checkout', 'errors.js', 'sale.discount'] },
    { key: 'custom', label: 'Run your own tests', groups: ['custom'] },
    { key: 'quality', label: 'Measure speed, SEO and accessibility', groups: ['speed', 'seo', 'a11y', 'links', 'policies'], full: true },
    { key: 'regional', label: 'Check the laws where you sell', groups: ['law.de', 'law.cookies', 'access.law', 'law.us'], full: true },
    { key: 'visual', label: 'Compare screenshots with the approved look', groups: ['visual'], full: true },
    { key: 'catalog', label: 'Check every product', groups: ['catalog', 'ai.copy'], full: true },
    { key: 'ai', label: 'AI review of how pages look', groups: ['ai.visual'], full: true },
  ];
  const EST = { 'journey.core': 14, 'journey.collection': 4, 'journey.search': 5, 'journey.variant': 4, 'journey.checkout': 8, 'errors.js': 1, speed: 24, seo: 5, a11y: 12, links: 14, policies: 4, catalog: 10, 'ai.visual': 20, 'ai.copy': 15, visual: 14, 'sale.discount': 10, 'law.de': 10, 'law.cookies': 12, 'access.law': 18, 'law.us': 1, custom: 10 };
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

  // ---------- Home: the store at a glance, and what owners do every day ----------
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
    const fails = problems.filter((c) => c.status === 'fail'), warns = problems.filter((c) => c.status === 'warn');
    const base = `#/s/${s.id}`;
    let body = '';
    if (activeRun && (activeRun.status === 'queued' || activeRun.status === 'running')) body += liveCard(activeRun, s);
    if (!res && !active) {
      body += `<section class="panel empty"><h2>Ready for its first check</h2><p>The first full check tests the shopping journey, speed, Google, accessibility and every product, and saves today’s look. ${s.monitoring ? 'Scheduled checks start after it.' : 'Monitoring is paused, so only checks you start will run.'}</p>${runLink(s, 'Run first check')}</section>`;
    }
    if (res) {
      // 1. The answer to "can customers buy right now?"
      const tone = { healthy: 'ok', warning: 'warn', critical: 'bad', locked: 'warn', blocked: 'warn' }[res.verdict] || 'warn';
      const headline = { healthy: 'Customers can buy', warning: 'Customers can buy', critical: 'Customers may not be able to buy', locked: 'We couldn’t get into your store', blocked: 'We were stopped at the door' }[res.verdict] || VERDICT[res.verdict];
      body += `<section class="panel status ${tone}" data-tour="hero">
        <span class="st-ic">${icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'stop' : 'alerts', 24)}</span>
        <div class="st-main"><h2>${esc(headline)}</h2><p>${esc(res.summary)}</p>
          <p class="st-when">Checked ${time(lastDone.finished_at || lastDone.created_at)}${s.monitoring && s.last_run_at && !active ? ` · next check ${esc(inMin(s.next_run_in))}` : ''}${s.monitoring ? '' : ' · monitoring paused'} · <a href="${base}/reports/${lastDone.id}">Latest report</a></p></div>
        <div class="st-score"><div class="dial" style="--v:${res.score ?? 0};--c:${{ healthy: 'var(--pass)', warning: 'var(--warn)', critical: 'var(--fail)' }[res.verdict] || 'var(--skip)'}"><div><span><b>${res.score ?? '–'}</b><small>health</small></span></div></div></div>
      </section>`;
      if (res.verdict === 'blocked') { const bc = res.checks.find((c) => c.id === 'fn.blocked'); body += `<div class="notice"><p><b>${esc(bc?.evidence?.vendor || 'Bot protection')} stopped our test browser.</b> ${esc(bc?.fix || '')}</p></div>`; }
      if (res.verdict === 'locked') body += `<form class="notice pw-inline" id="pw-inline" novalidate><p><b>Your store is password protected.</b> Enter the storefront password so we can shop it like a customer. ${EMB ? 'In Shopify: Online Store → Preferences → Password protection.' : ''}</p>
        <div class="inline-row"><input name="password" type="password" autocomplete="off" placeholder="Storefront password" required aria-label="Storefront password"><button class="btn" type="submit">${icon('play', 16)}Save and run the check</button></div>
        <p class="error-msg" role="alert"></p><p class="hint">We use it only to open your store for testing, and never show it again.</p></form>`;

      // 2. The numbers owners look at every day.
      const pct = (v) => (v == null ? '–' : `${v}%`);
      const toneOf = (v) => (v == null ? '' : v >= 99 ? 'good' : v >= 95 ? 'mid' : 'bad');
      const b = sc?.buyability, t = sc?.timeToFix, rr = sc?.revenueAtRisk, cat = sc?.catalog, pb = sc?.publishing, rules = sc?.rules;
      const bars = b ? b.daily.slice(-14).map((d) => `<i class="${d.pct == null ? 'none' : toneOf(d.pct)}" style="--h:${d.pct ?? 8}" title="${esc(d.day)}: ${d.pct == null ? 'no checks' : d.pct + '%'}"></i>`).join('') : '';
      const speed = sc?.speed?.ms ?? null;
      const sp = speed ? Math.round(speed / 100) / 10 : null;
      const tile = (href, label, value, sub, cls = '', extra = '') => `<a class="kpi ${cls}" href="${href}"><span class="k-l">${label}</span><b class="k-v">${value}</b><span class="k-s">${sub}</span>${extra}</a>`;
      const tiles = [
        tile(`${base}/reports`, 'Customers could buy · 7 days', `<span class="${toneOf(b?.week.pct)}">${pct(b?.week.pct)}</span>`, b ? `Today ${pct(b.day.pct)} · 30 days ${pct(b.month.pct)}` : 'After a few checks', 'lead', `<div class="sc-bars">${bars}</div>`),
        tile(`${base}/reports/${lastDone.id}`, 'Needs fixing', `<span class="${fails.length ? 'bad' : 'good'}">${fails.length}</span>`, warns.length ? `${plural(warns.length, 'more thing')} worth a look` : fails.length ? 'Nothing else to look at' : 'Nothing to fix'),
        tile(`${base}/settings`, 'Money at risk · 30 days', rr?.amount != null ? moneyTxt(rr.amount, rr.currency) : `${rr?.hours ?? 0} h`, rr?.amount != null ? `${rr.hours} h when customers couldn’t buy` : rr?.hours ? 'when customers couldn’t buy · add daily sales' : 'No lost buying time'),
        tile(`${base}/reports/${sc?.speed?.run || lastDone.id}`, 'Homepage on phones', sp != null ? `<span class="${sp <= 2.5 ? 'good' : sp <= 4 ? 'mid' : 'bad'}">${sp} s</span>` : '–', sp == null ? 'After a full check' : sp <= 2.5 ? 'Fast' : sp <= 4 ? 'A little slow' : 'Slow: shoppers may leave'),
        tile(`${base}/catalog`, 'Products', cat ? `<span class="${cat.withIssues ? 'mid' : 'good'}">${cat.withIssues}</span>` : '–', cat ? (cat.withIssues ? `of ${cat.products} need fixing` : `All ${cat.products} look right`) : 'After a full check'),
        tile(`${base}/alerts`, 'Time to fix', durTxt(t?.medianMinutes), t?.open ? `<span class="t-fail">${plural(t.open, 'problem')} still open</span>` : t?.incidents ? `typical, ${plural(t.incidents, 'incident')}` : 'No buying problems'),
        rules?.markets?.length ? tile(`${base}/reports/${rules.run?.id || lastDone.id}`, 'Laws where you sell', (() => { const ms = rules.markets.filter((m) => !m.pending); const met = ms.reduce((a, m) => a + m.met, 0), tot = ms.reduce((a, m) => a + m.total, 0); return tot ? `<span class="${met === tot ? 'good' : 'mid'}">${met}/${tot}</span>` : '–'; })(), rules.markets.map((m) => `${esc(m.label)}${m.pending ? '' : ` ${m.met}/${m.total}`}`).join(' · ') + ' rules met') : '',
        tile(`${base}/publish`, 'Changes checked · 30 days', String(pb?.checked ?? 0), pb?.checked ? (pb.caught ? `${plural(pb.caught, 'risky change')} caught` : 'All safe to publish') : 'Check a design before publishing'),
      ].filter(Boolean).join('');
      body += `<section class="kpis" data-tour="scorecard">${tiles}</section>`;
    }
    if (res || runs.length) {
      // 3. What to do today, and the things owners do most.
      const attention = problems.slice(0, 5).map((c) => `<li><a class="row" href="${base}/reports/${lastDone.id}" data-focus="${esc(c.id)}"><span class="sev ${c.status}">${c.status === 'fail' ? 'Fix' : 'Check'}</span><span><span class="t">${esc(c.title)}</span><span class="d">${esc(c.fix || c.detail)}</span></span>${icon('right', 15)}</a></li>`).join('');
      const action = (href, ic, t, d, attrs = '') => `<a class="qa" href="${href}" ${attrs}><span class="qa-ic">${icon(ic, 18)}</span><span><b>${t}</b><small>${d}</small></span>${icon('right', 15)}</a>`;
      const actions = [
        action(`${base}/run`, 'play', 'Run a check now', 'Shopping journey, full suite or pick checks'),
        action(`${base}/publish`, 'publish', 'Check a design before publishing', 'Your draft themes, side by side with live'),
        action(`${base}/run`, 'sparkle', 'Sale readiness check', 'Before Black Friday or a big sale', 'data-preset="sale"'),
        action(`${base}/suite/codes`, 'catalog', 'Test discount codes', s.config.discountCodes?.length ? `${plural(s.config.discountCodes.length, 'code')} checked daily` : 'Make sure your sale codes work'),
        action(`${base}/alerts`, 'alerts', 'Alerts', `Sent to ${esc(s.alert_email || 'your email')}`),
      ].join('');
      const feed = [
        ...(data.alerts || []).slice(0, 8).map((a) => ({ at: a.created_at, html: `<span class="sev ${a.state === 'failing' ? 'fail' : 'ok'}">${a.state === 'failing' ? 'Broke' : 'Fixed'}</span><span class="d">${esc(a.title || a.check_id)}</span>` })),
        ...runs.filter((r) => r.status === 'done' || r.status === 'error').slice(0, 8).map((r) => ({ at: r.finished_at || r.created_at, html: `<span class="dot ${esc(r.verdict || 'paused')}"></span><span class="d"><a href="${base}/reports/${r.id}">${esc(kindLabel(r))}${r.seq ? ` #${r.seq}` : ''}</a> · ${esc(VERDICT[r.verdict] || (r.status === 'error' ? 'Didn’t finish' : ''))}</span>` })),
      ].sort((x, y) => (y.at || '').localeCompare(x.at || '')).slice(0, 8);
      body += `<div class="dash-grid"><div class="dash-col">
        <section class="panel" data-tour="fix"><div class="panel-head"><h2>Needs your attention</h2>${lastDone ? `<a href="${base}/reports/${lastDone.id}">Full report ${icon('right', 14)}</a>` : ''}</div>
          ${attention ? `<ul class="list">${attention}</ul>${problems.length > 5 ? `<p class="muted" style="margin:10px 4px 0">and ${problems.length - 5} more in the report</p>` : ''}` : `<div class="all-clear">${icon('check', 20)}<p><b>Nothing needs your attention.</b> We’ll email you if that changes.</p></div>`}</section>
        <section class="panel"><div class="panel-head"><h2>Recent activity</h2><a href="${base}/runs">All runs ${icon('right', 14)}</a></div>
          ${feed.length ? `<ul class="act-feed">${feed.map((f) => `<li>${f.html}<span class="r">${time(f.at)}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Nothing yet.</p>'}</section>
        </div><div class="dash-col">
        <section class="panel"><div class="panel-head"><h2>Quick actions</h2></div><div class="qa-list">${actions}</div></section>
        <section class="panel"><div class="panel-head"><h2>Check history</h2></div>${strip(runs)}<div class="strip-legend"><span>Older</span><span>Latest</span></div>${LEGEND}</section>
      </div></div>`;
    }
    const meta = `<span>${esc(host(s.url))}</span>${s.platform ? `<span class="sep"></span><span>${esc(s.platform)}</span>` : ''}<span class="sep"></span><span>${esc(monitoringLine(s))}</span>`;
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, s.name || host(s.url), { crumb: 'Overview', meta, actions: openStore(s) + runButtons(s) })}${body}</div>`;
    $$('[data-focus]', ctx.main).forEach((a) => a.addEventListener('click', () => (S.focus = a.dataset.focus)));
    $$('[data-preset]', ctx.main).forEach((a) => a.addEventListener('click', () => (S.runPreset = a.dataset.preset)));
    $('#pw-inline')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget, pw = f.password.value;
      if (!pw) { f.querySelector('.error-msg').textContent = 'Enter the storefront password.'; return; }
      const done = busy(f.querySelector('button'), 'Starting');
      try {
        await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { password: pw } });
        const r = await api(`/api/stores/${s.id}/run`, { method: 'POST', body: {} });
        await loadStores();
        location.hash = `#/s/${s.id}/runs/${r.runId}`;
      } catch (ex) { done(); f.querySelector('.error-msg').textContent = ex.message; }
    });
    // The first time a store has results, show the owner around once.
    if (res && !active && s.config.toured === false && !S.touring) { startTour(s); return; }
    if (active || s.active_run_id) poll(S.stopping.size ? 1500 : 3000);
    else if (s.monitoring && s.last_run_at) poll(60000);
  };


  // Run validations: choose what to check, see the plan, then start. Nothing runs without this preview.
  function availability(g, s) {
    const shopify = !s.platform || /shopify/i.test(s.platform);
    if (!shopify && ((g.key.startsWith('journey.') && !g.locked) || g.key === 'catalog' || g.key === 'ai.copy')) return 'Shopify stores only for now';
    if (!groupAllowed(g)) return `In ${plansFor(featureOf(g.key))}`;
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
    const suite = keys(usable.filter((g) => g.locked || (!s.config.disabled.includes(g.key) && inMarket(g, s.config.markets))));
    const PRESETS = [
      { key: 'quick', title: 'Quick journey', desc: 'Can customers find a product, add it to the cart and reach checkout?', keys: keys(usable.filter((g) => g.run === 'journeys')) },
      { key: 'suite', title: 'Your test suite', desc: 'Everything switched on for scheduled full checks of this store.', keys: suite, tag: 'Recommended' },
      { key: 'sale', title: 'Sale readiness', desc: 'Before Black Friday or a big sale: buying on a phone, every price, discount codes, speed, app errors and how the store looks.', keys: keys(usable.filter((g) => ['journey.core', 'journey.search', 'journey.variant', 'journey.checkout', 'errors.js', 'sale.discount', 'catalog', 'speed', 'visual', 'law.cookies'].includes(g.key) && (g.key !== 'law.cookies' || inMarket(g, s.config.markets)))) },
      { key: 'all', title: 'Everything', desc: 'Every validation available, including ones switched off in your suite.', keys: keys(usable) },
    ].filter((p, i, all) => p.key !== 'all' || !same(p.keys, all[1].keys));
    let sel = [...suite];
    if (S.runPreset) { const p = PRESETS.find((x) => x.key === S.runPreset); if (p) sel = [...p.keys]; S.runPreset = null; }
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
            <span class="pr-tags">${g.locked ? '<span class="tag">Always included</span>' : ''}${g.ai ? '<span class="tag ai">AI</span>' : ''}${na ? `<span class="tag">${esc(na)}</span>` : ''}${!g.locked && !na && !inMarket(g, s.config.markets) ? '<span class="tag">Not where you sell</span>' : !g.locked && !na && s.config.disabled.includes(g.key) ? '<span class="tag">Off in your suite</span>' : ''}</span></label>`;
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
    return `<section class="panel scorecard" data-tour="scorecard"><div class="panel-head"><h2>Scorecard</h2><span class="muted" style="font-size:12.5px">Last 30 days</span></div><div class="sc-grid ${sc.rules?.markets.length ? 'six' : ''}">
      ${tile('Buyability · 7 days', `<span class="${tone(b.week.pct)}">${pctTxt(b.week.pct)}</span>`, `How often customers could buy. Today ${pctTxt(b.day.pct)} · 30 days ${pctTxt(b.month.pct)}`, `<div class="sc-bars" aria-label="Buyability by day, last 14 days">${bars}</div>`, 'lead')}
      ${tile('Time to fix', durTxt(t.medianMinutes), t.open ? `<span class="t-fail">${plural(t.open, 'problem')} still open</span>` : t.incidents ? `Typical, across ${plural(t.incidents, 'incident')}` : 'No buying problems in 30 days')}
      ${tile('Revenue at risk', r.amount != null ? moneyTxt(r.amount, r.currency) : `${r.hours} h`, r.amount != null ? `${r.hours} h when customers couldn’t buy` : r.hours ? `when customers couldn’t buy · <a href="#/s/${s.id}/settings">add daily sales</a> to see the amount` : `No lost buying time · <a href="#/s/${s.id}/settings">add daily sales</a>`)}
      ${tile('Product accuracy', c ? pctTxt(c.pct) : '–', c ? (c.withIssues ? `${c.withIssues} of ${c.products} products need fixing` : `All ${c.products} products look right`) : 'After the first full check')}
      ${sc.rules?.markets.length ? tile('Rules met', sc.rules.run ? sc.rules.markets.filter((m) => !m.pending).map((m) => `<span class="${m.total && m.met === m.total ? 'good' : 'mid'}">${m.met}/${m.total}</span>`).join(' · ') || '–' : '–', sc.rules.run ? sc.rules.markets.map((m) => `${esc(m.label)}: ${m.pending ? 'after the next full check' : m.open.length ? `${m.open.length} to fix` : 'all met'}`).join(' · ') + ` · <a href="#/s/${s.id}/reports/${sc.rules.run.id}">details</a>` : 'After the next full check') : ''}
      ${tile('Changes checked', String(pb.checked), pb.checked ? (pb.caught ? `${plural(pb.caught, 'risky change')} caught before publishing` : 'All safe to publish') : `<a href="#/s/${s.id}/publish">Check a design before publishing</a>`)}
    </div></section>`;
  }

  // Test suite
  const marketNames = (codes) => codes.map((c) => S.catalog.markets.find((m) => m.code === c)?.label || c);
  const inMarket = (g, markets) => !g.markets || g.markets.some((m) => (markets || []).includes(m));
  function suiteRows(groups, disabled, { shopify = true, aiEnabled = false, markets = null, storeId = null } = {}) {
    const list = groups.filter((g) => !g.ai || aiEnabled);
    const areas = [...new Set(list.map((g) => g.area))];
    return areas.map((area) => `<section class="suite-area"><h3>${esc(area)}</h3><div class="rows">${list.filter((g) => g.area === area).map((g) => {
      const journeyOnly = g.key.startsWith('journey.') && !g.locked && !shopify;
      const outside = markets && !inMarket(g, markets);
      const notPlan = !groupAllowed(g);
      const on = g.locked || (!disabled.includes(g.key) && !journeyOnly && !outside && !notPlan);
      return `<label class="check-row ${on ? '' : 'off'}">
        <span class="switch"><input type="checkbox" name="g" value="${esc(g.key)}" ${on ? 'checked' : ''} ${g.locked || journeyOnly || outside || notPlan ? 'disabled' : ''} aria-label="${esc(g.label)}"><span></span></span>
        <span><b>${esc(g.label)}</b><p>${esc(g.description)}</p>${journeyOnly ? '<p class="unavailable">Available for Shopify stores. Other platforms are coming.</p>' : ''}${g.markets && !notPlan ? `<p class="${outside ? 'unavailable' : 'muted'}" style="font-size:12.5px">For stores selling in ${esc(marketNames(g.markets).join(', '))}.${outside ? (storeId ? ` <a href="#/s/${storeId}/settings">Add where you sell</a> to turn it on.` : ' Choose one of these countries above to turn it on.') : ''}</p>` : ''}</span>
        <span class="when">${notPlan ? `<a class="plan-tag" href="#/account/billing" title="Included in ${esc(plansFor(featureOf(g.key)))}">${icon('lock', 12)}${esc(plansFor(featureOf(g.key)))}</a>` : g.locked ? 'Always on' : g.run === 'journeys' ? 'Every test' : 'Full check'}</span></label>`;
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
    const tab = ['product', 'codes'].includes(ctx.r.a) ? ctx.r.a : null;
    const base = `#/s/${s.id}/suite`;
    const shopify = !s.platform || /shopify/i.test(s.platform);
    const head = storeHead(s, 'Test suite') + `<p class="lede-sm">Choose what Store Guard checks on ${esc(s.name || host(s.url))}. Journey checks run on every scheduled test; the rest run with the full check.</p>` + tabs(base, [[null, 'Checks'], ['product', 'Test product'], ['codes', 'Discount codes']], tab);
    if (!tab) {
      ctx.main.innerHTML = `<div class="main-inner narrow-page">${head}<form id="suite">${suiteRows(S.catalog.groups, s.config.disabled, { shopify, aiEnabled: S.catalog.aiEnabled, markets: s.config.markets, storeId: s.id })}</form></div>`;
      const form = $('#suite');
      const mark = savebar(form.parentElement, {
        onSave: async () => { await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { disabled: readDisabled(form) } } }); await loadStores(); },
        onDiscard: () => render(),
      });
      form.addEventListener('change', (e) => { e.target.closest('.check-row')?.classList.toggle('off', !e.target.checked); mark(); });
      return;
    }
    if (tab === 'codes') {
      const codes = s.config.discountCodes.length ? s.config.discountCodes : [{ code: '', percent: null }];
      const row = (c, i) => `<div class="code-row"><div class="field"><label for="dc${i}">Code</label><input id="dc${i}" name="code" value="${esc(c.code)}" placeholder="e.g. BLACKFRIDAY20" maxlength="40" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label for="dp${i}">Expected discount <span class="muted" style="font-weight:400">(optional)</span></label><div class="suffix"><input id="dp${i}" name="percent" type="number" min="1" max="99" value="${c.percent ?? ''}" placeholder="e.g. 20"><span>% off</span></div></div>
        <button type="button" class="icon-btn" data-rm aria-label="Remove code" data-tip="Remove">${icon('trash', 16)}</button></div>`;
      ctx.main.innerHTML = `<div class="main-inner narrow-page">${head}
        <div class="form-section" style="border-top:0;padding-top:0"><div><h3>Sale and discount codes</h3><p class="explain">Each full check puts a product in a fresh cart, applies every code, and checks the price really drops, by the amount you expect. Nothing is bought, and the cart is emptied. Add your Black Friday code before you email it to customers.</p></div>
          <div class="controls"><form id="codes">${codes.map(row).join('')}</form>
            <div class="inline-row"><button type="button" class="btn secondary small" id="addc">${icon('add', 15)}Add a code</button><span class="muted" style="font-size:12.5px">Up to 5 codes.</span></div>
            <p class="error-msg" id="dc-err" role="alert"></p>
            ${s.platform && !/shopify/i.test(s.platform) ? '<p class="hint">Discount codes are checked on Shopify stores for now.</p>' : ''}</div></div></div>`;
      const form = $('#codes');
      const mark = savebar($('.main-inner', ctx.main), {
        onSave: async () => {
          const list = $$('.code-row', form).map((r) => ({ code: r.querySelector('[name=code]').value.trim(), percent: r.querySelector('[name=percent]').value })).filter((x) => x.code);
          try { await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { discountCodes: list } } }); $('#dc-err').textContent = ''; } catch (ex) { $('#dc-err').textContent = ex.message; throw ex; }
          await loadStores();
        },
        onDiscard: () => render(),
      });
      form.addEventListener('input', mark);
      form.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; if ($$('.code-row', form).length > 1) b.closest('.code-row').remove(); else b.closest('.code-row').querySelectorAll('input').forEach((i) => (i.value = '')); mark(); });
      $('#addc').onclick = () => { if ($$('.code-row', form).length >= 5) return toast('Up to 5 codes', 'error'); form.insertAdjacentHTML('beforeend', row({ code: '', percent: null }, Date.now())); mark(); form.lastElementChild.querySelector('input').focus(); };
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

  // ---------- Your tests: the store's own tests, built in a form or written as a file (src/custom-tests-routes.js) ----------
  const YT_STEPS = {
    open: { label: 'Open a page', ph: '/pages/contact or {product}', argLabel: 'Page' },
    click: { label: 'Click', ph: 'text=Check, #button or role=button:Check', argLabel: 'What to click' },
    fill: { label: 'Type into a field', ph: '#pincode', argLabel: 'Field' },
    choose: { label: 'Choose an option', ph: '#size or text=Size', argLabel: 'Drop-down or button' },
    quantity: { label: 'Set quantity', ph: '2', argLabel: 'Quantity' },
    add_to_cart: { label: 'Add to cart' },
    open_cart: { label: 'Open the cart' },
    checkout: { label: 'Go to checkout (stops before payment)' },
    wait_for: { label: 'Wait for something to show', ph: '.delivery-result', argLabel: 'What to wait for' },
    expect_visible: { label: 'Check something is showing', ph: '.size-guide', argLabel: 'What should show' },
    expect_hidden: { label: 'Check something is not showing', ph: '.error', argLabel: 'What should not show' },
    expect_text: { label: 'Check the text', ph: '.delivery-result', argLabel: 'Where' },
    expect_price: { label: 'Check a price', ph: '.price', argLabel: 'Where the price is' },
    expect_count: { label: 'Count things on the page', ph: '.product-card', argLabel: 'What to count' },
    expect_url: { label: 'Check the page address', ph: '/cart', argLabel: 'The address contains' },
    expect_cart_total: { label: 'Check the cart total' },
    expect_cart_items: { label: 'Check the number of items in the cart' },
    expect_no_errors: { label: 'Check there were no script errors' },
  };
  const YT_EXTRA = { value: 'Text to type', option: 'Option to choose', contains: 'Should contain', timeout: 'Wait up to (seconds)' };
  const YT_EXAMPLES = [
    { title: 'Delivery checker (pincode)', why: 'Your product page has a box where shoppers check if you deliver to them. This test types a pincode and checks the answer.',
      test: { name: 'Delivery checker works', severity: 'major', runs: 'full', device: 'mobile', steps: [{ open: '{product}' }, { fill: '#pincode', value: '560001' }, { click: 'text=Check' }, { expect_text: '.delivery-result', contains: 'Delivery available' }] } },
    { title: 'Size guide opens', why: 'Shoppers who can’t see the size guide buy the wrong size, or don’t buy. This test opens it on a phone.',
      test: { name: 'Size guide opens', severity: 'minor', runs: 'full', device: 'mobile', steps: [{ open: '{product}' }, { click: 'text=Size guide' }, { expect_visible: '.size-guide' }] } },
    { title: 'Two in the cart, right total', why: 'Checks that adding two of your test product gives two items in the cart and a total of at least twice the price.',
      test: { name: 'Two items and the right total', severity: 'critical', runs: 'journeys', device: 'desktop', steps: [{ open: '{product}' }, { quantity: 2 }, { add_to_cart: true }, { expect_cart_items: 2 }, { open_cart: true }, { expect_no_errors: true }] } },
  ];
  // A target as the owner writes it: "#id", "text=Check" or "role=button:Check".
  const ytTarget = (t) => (!t || typeof t !== 'object' ? (t ?? '') : t.text ? `text=${t.text}` : t.role ? `role=${t.role}${t.name ? `:${t.name}` : ''}` : t.css || '');
  const ytKind = (st) => Object.keys(YT_STEPS).find((k) => k in st) || 'open';
  const ytSay = (st) => {
    const k = ytKind(st), v = st[k];
    const tail = typeof v === 'object' && v && !('css' in v || 'text' in v || 'role' in v) ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ') : v === true ? '' : ytTarget(v);
    const more = ['value', 'option', 'contains', 'equals', 'min', 'max'].filter((x) => st[x] != null).map((x) => `${x} ${st[x]}`).join(', ');
    return `${YT_STEPS[k].label}${tail !== '' ? `: ${tail}` : ''}${more ? ` (${more})` : ''}`;
  };
  // The editor's tests use the written forms, so a test saved from the form reads like the file.
  const ytPlain = ({ id, ...t }) => ({ ...t, steps: t.steps.map((st) => Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v && typeof v === 'object' && ('css' in v || 'text' in v || 'role' in v) ? (/^(text|role)=/i.test(v.css || '') ? v : ytTarget(v)) : v]))) });
  async function ytRaw(path, { method = 'GET', text, type = 'text/plain' } = {}) {
    const headers = {};
    if (text != null) headers['Content-Type'] = type;
    if (EMB) headers.Authorization = `Bearer ${await window.shopify.idToken()}`;
    const r = await fetch(path, { method, headers, credentials: 'same-origin', body: text });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || 'Something went wrong. Try again.'), { status: r.status, problems: j.problems }); }
    return r;
  }
  // Downloads work inside Shopify admin too: the file is fetched with the session, then saved from the page.
  async function ytDownload(s, version) {
    const r = await ytRaw(`/api/stores/${s.id}/custom-tests?download=1${version ? `&version=${version}` : ''}`);
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'tharam-tests.yaml';
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const ytProblems = (ex) => (ex.problems?.length > 1 ? `<ul class="yt-problems">${ex.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : `<p>${esc(ex.problems?.[0] || ex.message)}</p>`);
  function ytTrail(r) {
    return `<div class="yt-try ${r.status === 'pass' ? 'ok' : 'bad'}" role="status"><p class="yt-try-head"><span class="pill ${r.status === 'pass' ? 'healthy' : 'critical'}">${r.status === 'pass' ? 'Worked' : 'Failed'}</span> ${esc(r.message)} <span class="muted">${(r.ms / 1000).toFixed(1)} s</span></p>
      <div class="yt-shots">${r.steps.map((st) => `<figure class="${st.status === 'fail' ? 'fail' : ''}"><figcaption><b>${st.n}.</b> ${esc(st.text)}${st.status === 'fail' ? ` <b class="t-fail">failed</b>${st.error ? `: ${esc(st.error)}` : ''}` : ''}</figcaption>${st.image ? `<img src="${esc(st.image)}" alt="Step ${st.n}: ${esc(st.text)}" loading="lazy">` : ''}</figure>`).join('')}</div></div>`;
  }

  STORE_PAGES.tests = async (ctx, s) => {
    const d = await api(`/api/stores/${s.id}/custom-tests`);
    if (!ctx.alive()) return;
    const base = `#/s/${s.id}/tests`;
    const tab = ['file', 'history', 'help', 'edit'].includes(ctx.r.a) ? ctx.r.a : null;
    const tests = (d.file?.tests || []).map(ytPlain);
    const ids = (d.file?.tests || []).map((t) => t.id);
    const format = d.file?.format || 'yaml';
    const used = `${tests.length} of ${d.limits.tests} test${d.limits.tests === 1 ? '' : 's'} on your plan`;
    const actions = `<button type="button" class="btn secondary" id="yt-upload">${icon('arrow', 16)}Upload file</button>${d.file ? `<button type="button" class="btn secondary" id="yt-download">Download file</button>` : ''}${tests.length < d.limits.tests ? `<a class="btn" href="${base}/edit/new">${icon('add', 16)}New test</a>` : ''}<input type="file" id="yt-file" accept=".yaml,.yml,.json,.txt,application/json,text/yaml" hidden>`;
    const head = storeHead(s, 'Your tests', { actions, meta: esc(used) }) + `<p class="lede-sm">Add tests for things only your store has, like a delivery checker or a size guide. We run them like a shopper, on your store only, and stop before payment.</p>`
      + tabs(base, [[null, 'Tests', tests.length], ['file', 'File'], ['history', 'History', d.history.length], ['help', 'Help and examples']], tab === 'edit' ? null : tab);
    // Every change is saved as a new version of the file; nothing is ever lost.
    const saveList = async (list, msg) => {
      await api(`/api/stores/${s.id}/custom-tests`, { method: 'PUT', body: { tests: list, format } });
      toast(msg);
      render({ silent: true });
    };
    const bindHead = () => {
      $('#yt-upload').onclick = () => $('#yt-file').click();
      $('#yt-file').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 100 * 1024) return toast('That file is larger than 100 KB.', 'error');
        try {
          const text = await f.text();
          await ytRaw(`/api/stores/${s.id}/custom-tests`, { method: 'PUT', text, type: /\.json$/i.test(f.name) ? 'application/json' : 'text/yaml' });
          toast('File uploaded. Your tests are saved.');
          location.hash = base;
          render({ silent: true });
        } catch (ex) {
          formDialog({ title: 'This file has mistakes', body: `<p class="muted">Nothing was saved. Fix these and upload it again:</p>${ytProblems(ex)}`, cancel: 'Close', onSubmit: async () => null });
        } finally { e.target.value = ''; }
      };
      const dl = $('#yt-download');
      if (dl) dl.onclick = async () => { const done = busy(dl, 'Downloading'); try { await ytDownload(s); } catch (ex) { toast(ex.message, 'error'); } finally { done(); } };
    };

    if (tab === 'edit') return ytEditor(ctx, s, d, tests, format, base);

    if (tab === 'file') {
      const text = d.file?.text ?? d.example;
      ctx.main.innerHTML = `<div class="main-inner">${head}
        <section class="panel"><div class="yt-file-head"><p class="sub" style="margin:0">${d.file ? `Version ${d.file.version}, ${esc(format.toUpperCase())}. Edit and save: we check the file first and keep the old version.` : 'No tests yet. Here is an example to start from.'}</p>
          <span class="muted">YAML or JSON · up to ${d.maxSteps} steps a test</span></div>
          <label class="sr-only" for="yt-text">Your tests file</label>
          <textarea id="yt-text" class="yt-code" rows="22" spellcheck="false">${esc(text)}</textarea>
          <div class="yt-err" id="yt-err" role="alert"></div>
          <div class="inline-row"><button type="button" class="btn" id="yt-save">Save file</button><span class="muted" style="font-size:12.5px">Mistakes are shown here, line by line, and nothing is saved until they’re fixed.</span></div></section></div>`;
      bindHead();
      const ta = $('#yt-text');
      ta.addEventListener('input', () => { S.dirty = true; });
      $('#yt-save').onclick = async (e) => {
        const done = busy(e.currentTarget, 'Checking and saving');
        try {
          const r = await ytRaw(`/api/stores/${s.id}/custom-tests`, { method: 'PUT', text: ta.value, type: /^\s*[[{]/.test(ta.value) ? 'application/json' : 'text/yaml' });
          const j = await r.json();
          S.dirty = false;
          $('#yt-err').innerHTML = '';
          toast(j.unchanged ? 'No changes to save' : `Saved as version ${j.file.version}`);
          render({ silent: true });
        } catch (ex) { $('#yt-err').innerHTML = `<div class="notice fail-n">${ytProblems(ex)}</div>`; } finally { done(); }
      };
      return;
    }

    if (tab === 'history') {
      ctx.main.innerHTML = `<div class="main-inner" id="yt-root">${head}
        ${d.history.length ? `<section class="panel flush"><div class="table-wrap flat"><table class="data"><thead><tr><th>Version</th><th>Saved</th><th>Tests</th><th></th></tr></thead><tbody>
          ${d.history.map((h, i) => `<tr data-v="${h.version}"><td><span class="cell-main">Version ${h.version}</span>${i === 0 ? ' <span class="pill healthy">In use</span>' : ''}<div class="cell-sub">${esc(h.format.toUpperCase())}</div></td><td>${time(h.savedAt)}</td><td>${h.tests}</td>
            <td class="row-actions"><button type="button" class="btn small ghost" data-view="${h.version}">View</button><button type="button" class="btn small ghost" data-dl="${h.version}">Download</button>${i === 0 ? '' : `<button type="button" class="btn small secondary" data-restore="${h.version}">Restore</button>`}</td></tr>`).join('')}
          </tbody></table></div></section>
          <p class="hint">Every save is kept. Restoring an older version saves it again as the newest one, so you can always go back.</p>` : `<div class="empty panel"><h2>No versions yet</h2><p>Each time you save your tests, the version is kept here.</p></div>`}
        <div id="yt-view"></div></div>`;
      bindHead();
      $('#yt-root').addEventListener('click', async (e) => {
        const v = e.target.closest('[data-view]'), dl = e.target.closest('[data-dl]'), rs = e.target.closest('[data-restore]');
        if (v) {
          const f = await api(`/api/stores/${s.id}/custom-tests?version=${v.dataset.view}`);
          $('#yt-view').innerHTML = `<section class="panel"><h2>Version ${f.file.version}</h2><p class="sub">${esc(exact(f.file.savedAt))} · ${plural(f.file.tests.length, 'test')}: ${esc(f.file.tests.map((t) => t.name).join(', '))}</p><pre class="yt-code">${esc(f.file.text)}</pre></section>`;
          $('#yt-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (dl) {
          try { await ytDownload(s, dl.dataset.dl); } catch (ex) { toast(ex.message, 'error'); }
        } else if (rs) {
          const n = rs.dataset.restore;
          if (!(await confirmDialog({ title: `Restore version ${n}?`, body: `Your tests go back to how they were in version ${n}. It is saved as a new version, so the current one stays in the history.`, confirm: 'Restore' }))) return;
          try { const r = await api(`/api/stores/${s.id}/custom-tests/restore`, { method: 'POST', body: { version: Number(n) } }); toast(r.unchanged ? 'That version is already in use' : `Version ${n} restored as version ${r.file.version}`); render({ silent: true }); }
          catch (ex) { toast(ex.message, 'error'); }
        }
      });
      return;
    }

    if (tab === 'help') {
      ctx.main.innerHTML = `<div class="main-inner narrow-page">${head}
        <section class="panel"><h2>How your tests work</h2>
          <ol class="yt-how"><li><b>A test is a list of steps</b>, the way you’d check something by hand: open a page, click, type, then check what you see.</li>
          <li><b>Checks are the steps that start with “Check”.</b> If what you expect isn’t there, the test fails at that step and we keep a screenshot.</li>
          <li><b>Choose when it runs:</b> with every shopping check, or once a day with the full check. A failure sends an alert like our own checks, with the severity you pick.</li>
          <li><b>Point at things on the page</b> by their visible text (<code>text=Check</code>), a button’s name (<code>role=button:Check</code>), or, if you know it, a CSS selector (<code>#pincode</code>).</li>
          <li><b>Use your store’s values:</b> <code>{product}</code> is your test product’s page; <code>{product_title}</code>, <code>{price}</code> and <code>{variant}</code> work in any text.</li>
          <li><b>Try it now</b> runs one test straight away and shows a screenshot of every step, so you can see what we see.</li></ol>
          <p class="muted">Tests stay on your store, never pay, and empty the cart afterwards. Up to ${d.maxSteps} steps and 60 seconds a test.</p></section>
        ${YT_EXAMPLES.map((x, i) => `<section class="panel yt-example"><div class="yt-ex-head"><div><h2>Example ${i + 1}: ${esc(x.title)}</h2><p class="sub">${esc(x.why)}</p></div>
          <button type="button" class="btn secondary small" data-ex="${i}" ${tests.some((t) => t.name === x.test.name) || tests.length >= d.limits.tests ? 'disabled' : ''}>${tests.some((t) => t.name === x.test.name) ? 'Added' : 'Add to my tests'}</button></div>
          <ol class="yt-ex-steps">${x.test.steps.map((st) => `<li>${esc(ytSay(st))}</li>`).join('')}</ol>
          <details><summary>As a file</summary><pre class="yt-code">${esc(`tests:\n  - name: ${x.test.name}\n    severity: ${x.test.severity}\n    runs: ${x.test.runs}\n    device: ${x.test.device}\n    steps:\n${x.test.steps.map((st) => Object.entries(st).map(([k, v], j) => `${j ? '        ' : '      - '}${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n')).join('\n')}`)}</pre></details></section>`).join('')}
      </div>`;
      bindHead();
      $$('[data-ex]', ctx.main).forEach((b) => (b.onclick = async () => {
        const x = YT_EXAMPLES[Number(b.dataset.ex)];
        const done = busy(b, 'Adding');
        try { await saveList([...tests, x.test], `“${x.test.name}” added. Change the targets to match your store, then try it.`); location.hash = `${base}/edit/${tests.length}`; }
        catch (ex) { done(); toast(ex.message, 'error'); }
      }));
      return;
    }

    // Tests list
    const res = d.results || {};
    const resultCell = (t) => {
      const r = res[ids[tests.indexOf(t)]];
      if (!r) return '<span class="muted">Not run yet</span>';
      return `<span class="pill ${r.status === 'pass' ? 'healthy' : r.status === 'fail' ? 'critical' : 'warning'}">${r.status === 'pass' ? 'Passed' : r.status === 'fail' ? 'Failed' : 'To check'}</span><div class="cell-sub">${time(r.at)}${r.ms ? ` · took ${(r.ms / 1000).toFixed(1)} s` : ''} · <a href="#/s/${s.id}/runs/${r.runId}">see run</a></div>`;
    };
    ctx.main.innerHTML = `<div class="main-inner" id="yt-root">${head}
      ${tests.length ? `<section class="panel flush"><div class="table-wrap flat"><table class="data yt-list"><thead><tr><th style="width:60px">On</th><th>Test</th><th style="width:210px">Last result</th><th></th></tr></thead><tbody>
        ${tests.map((t, i) => `<tr data-i="${i}" class="${t.enabled === false ? 'off' : ''}"><td><label class="switch" title="${t.enabled === false ? 'Off: not run' : 'On'}"><input type="checkbox" data-toggle="${i}" ${t.enabled === false ? '' : 'checked'} aria-label="Run “${esc(t.name)}”"><span></span></label></td>
          <td><a class="cell-main" href="${base}/edit/${i}">${esc(t.name)}</a><div class="cell-sub">${esc({ critical: 'Critical', major: 'Major', minor: 'Minor' }[t.severity])} · ${t.runs === 'journeys' ? 'every shopping check' : 'daily full check'} · ${esc(t.device)} · ${plural(t.steps.length, 'step')}</div></td>
          <td>${resultCell(t)}</td>
          <td class="row-actions"><button type="button" class="btn small secondary" data-try="${i}">${icon('play', 14)}Try it now</button><a class="icon-btn" href="${base}/edit/${i}" aria-label="Edit “${esc(t.name)}”" data-tip="Edit">${icon('edit', 16)}</a><button type="button" class="icon-btn" data-dup="${i}" aria-label="Duplicate “${esc(t.name)}”" data-tip="Duplicate">${icon('copy', 16)}</button><button type="button" class="icon-btn" data-del="${i}" aria-label="Delete “${esc(t.name)}”" data-tip="Delete">${icon('trash', 16)}</button></td></tr>
          <tr class="yt-try-row" id="yt-try-${i}" hidden><td colspan="4"></td></tr>`).join('')}
        </tbody></table></div></section>`
      : `<div class="empty panel"><h2>No tests of your own yet</h2><p>Build one step by step, start from an example, or upload a file.</p><div class="inline-row" style="justify-content:center"><a class="btn" href="${base}/edit/new">${icon('add', 16)}New test</a><a class="btn secondary" href="${base}/help">See examples</a></div></div>`}
      </div>`;
    bindHead();
    const root = $('#yt-root');
    root.addEventListener('change', async (e) => {
      const tg = e.target.closest('[data-toggle]');
      if (!tg) return;
      const i = Number(tg.dataset.toggle);
      const list = tests.map((t, j) => (j === i ? { ...t, enabled: tg.checked } : t));
      try { await saveList(list, tg.checked ? `“${tests[i].name}” is on` : `“${tests[i].name}” is off. It stays in your file but won’t run.`); } catch (ex) { tg.checked = !tg.checked; toast(ex.message, 'error'); }
    });
    root.addEventListener('click', async (e) => {
      const dup = e.target.closest('[data-dup]'), del = e.target.closest('[data-del]'), tr = e.target.closest('[data-try]');
      if (dup) {
        const t = tests[Number(dup.dataset.dup)];
        if (tests.length >= d.limits.tests) return toast(`Your plan allows ${d.limits.tests} tests per store.`, 'error');
        let name = `${t.name} (copy)`, n = 2;
        while (tests.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${t.name} (copy ${n++})`;
        try { await saveList([...tests, { ...t, name: name.slice(0, 80) }], `Copied as “${name}”`); } catch (ex) { toast(ex.message, 'error'); }
      } else if (del) {
        const i = Number(del.dataset.del);
        if (tests.length === 1) return toast('This is your only test. Turn it off instead, or upload a new file.', 'error');
        if (!(await confirmDialog({ title: `Delete “${tests[i].name}”?`, body: 'It stops running. Earlier versions of your file keep it, so you can restore it from History.', confirm: 'Delete test', danger: true }))) return;
        try { await saveList(tests.filter((_, j) => j !== i), `“${tests[i].name}” deleted`); } catch (ex) { toast(ex.message, 'error'); }
      } else if (tr) {
        const i = Number(tr.dataset.try);
        const row = $(`#yt-try-${i}`);
        row.hidden = false;
        row.firstElementChild.innerHTML = '<p class="muted"><span class="spinner"></span> Running this test on your store. It takes up to a minute…</p>';
        const done = busy(tr, 'Running');
        try {
          const r = await api(`/api/stores/${s.id}/custom-tests/${encodeURIComponent(tests[i].name)}/try`, { method: 'POST' });
          row.firstElementChild.innerHTML = ytTrail(r);
          $$('.yt-shots img', row).forEach((im) => (im.onclick = () => lightbox(im.src, im.alt)));
        } catch (ex) { row.firstElementChild.innerHTML = `<div class="notice fail-n"><p>${esc(ex.message)}</p></div>`; } finally { done(); }
      }
    });
  };

  // The step builder: one test, edited as a form.
  function ytEditor(ctx, s, d, tests, format, base) {
    const isNew = ctx.r.b === 'new';
    const idx = isNew ? tests.length : Number(ctx.r.b);
    if (!isNew && !tests[idx]) { location.replace(base); return; }
    if (isNew && tests.length >= d.limits.tests) { toast(`Your plan allows ${d.limits.tests} tests per store.`, 'error'); location.replace(base); return; }
    const head = storeHead(s, isNew ? 'New test' : 'Edit test', { crumb: `<a href="#/s/${s.id}">${esc(s.name || host(s.url))}</a> › <a href="${base}">Your tests</a>` });
    const t = isNew ? { name: '', severity: 'major', runs: 'full', device: 'desktop', enabled: true, fix: '', steps: [{ open: '{product}' }] } : JSON.parse(JSON.stringify(tests[idx]));
    const lib = Object.fromEntries(d.library.map((x) => [x.key, x]));
    // Describe it in words: AI drafts the steps into this form; nothing is saved until the owner saves.
    const ai = isNew && d.ai?.available ? { desc: '', page: '', note: '', left: d.ai.left } : null;
    const aiPanel = () => (ai ? `<section class="panel yt-ai"><h2>Describe it in words <span class="tag ai">AI</span></h2><p class="sub">Say what a shopper does and what should happen. We open the page, and AI drafts the steps below for you to try and save.</p>
            <div class="field"><label for="yt-desc">What should the test do?</label><textarea id="yt-desc" rows="3" maxlength="600" placeholder="e.g. Enter pincode 560001 on a product page, press Check and make sure it says delivery is available">${esc(ai.desc)}</textarea></div>
            <div class="inline-row"><div class="field" style="flex:1;margin:0"><label for="yt-page">Page to start on <span class="muted" style="font-weight:400">(optional)</span></label><input id="yt-page" maxlength="300" value="${esc(ai.page)}" placeholder="Your test product, or a page like /pages/contact" spellcheck="false"></div>
              <button type="button" class="btn secondary" id="yt-draft" ${ai.left ? '' : 'disabled'} style="align-self:flex-end">Draft the steps</button></div>
            <p class="muted" style="font-size:12.5px;margin:8px 0 0">${ai.left ? `${ai.left} AI ${ai.left === 1 ? 'draft' : 'drafts'} left today.` : 'You’ve used today’s AI drafts. Build the test with the steps below.'}</p>
            <div id="yt-ai-out" role="status">${ai.note ? `<div class="notice ok-n"><p>${esc(ai.note)}</p></div>` : ''}</div></section>` : '');
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const stepRow = (st, i) => {
      const k = ytKind(st), def = lib[k], meta = YT_STEPS[k];
      const v = st[k];
      const range = def.arg === 'range' ? (typeof v === 'number' ? { equals: v } : v || {}) : st;
      let fields = '';
      if (['target', 'path', 'text', 'number'].includes(def.arg)) fields += `<div class="field"><label>${esc(meta.argLabel)}</label><input data-f="arg" ${def.arg === 'number' ? 'type="number" min="1" max="999"' : ''} value="${esc(def.arg === 'target' ? ytTarget(v) : v ?? '')}" placeholder="${esc(meta.ph)}" spellcheck="false"></div>`;
      for (const x of [...def.need, ...def.opt]) fields += `<div class="field"><label>${esc(YT_EXTRA[x])}${def.opt.includes(x) ? ' <span class="muted" style="font-weight:400">(optional)</span>' : ''}</label><input data-f="${x}" ${x === 'timeout' ? 'type="number" min="1" max="30"' : ''} value="${esc(st[x] ?? '')}" spellcheck="false"></div>`;
      if (def.range || def.arg === 'range') fields += ['equals', 'min', 'max'].map((x) => `<div class="field yt-num"><label>${{ equals: 'Exactly', min: 'At least', max: 'At most' }[x]}</label><input data-f="${x}" type="number" step="any" value="${esc(range[x] ?? '')}"></div>`).join('');
      return `<li class="yt-step" draggable="true" data-i="${i}"><span class="yt-grip" aria-hidden="true" title="Drag to move">⋮⋮</span><span class="yt-n">${i + 1}</span>
        <div class="yt-step-body"><select data-f="kind" aria-label="Step ${i + 1}">${Object.entries(YT_STEPS).map(([key, m]) => opt(key, m.label, k)).join('')}</select><div class="yt-fields">${fields}</div></div>
        <div class="yt-step-acts"><button type="button" class="icon-btn" data-up="${i}" aria-label="Move step ${i + 1} up" ${i ? '' : 'disabled'}>↑</button><button type="button" class="icon-btn" data-down="${i}" aria-label="Move step ${i + 1} down" ${i < t.steps.length - 1 ? '' : 'disabled'}>↓</button><button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove step ${i + 1}">${icon('trash', 15)}</button></div></li>`;
    };
    // Reads the form back into the test (blank optional fields are left out).
    const read = () => {
      const f = $('#yt-form');
      t.name = f.name.value.trim(); t.severity = f.severity.value; t.runs = f.runs.value; t.device = f.device.value; t.enabled = f.enabled.checked; t.fix = f.fix.value.trim();
      t.steps = $$('.yt-step', f).map((li) => {
        const k = $('[data-f=kind]', li).value, def = lib[k];
        const val = (x) => $(`[data-f="${x}"]`, li)?.value.trim() ?? '';
        const num = (x) => (val(x) === '' ? undefined : Number(val(x)));
        const st = {};
        if (def.arg === 'flag') st[k] = true;
        else if (def.arg === 'number') st[k] = num('arg');
        else if (def.arg === 'range') st[k] = Object.fromEntries(['equals', 'min', 'max'].filter((x) => num(x) != null).map((x) => [x, num(x)]));
        else st[k] = val('arg');
        for (const x of def.need) st[x] = val(x);
        for (const x of def.opt) if (val(x) !== '') st[x] = x === 'timeout' ? num(x) : val(x);
        if (def.range) for (const x of ['equals', 'min', 'max']) if (num(x) != null) st[x] = num(x);
        return st;
      });
      if (!t.fix) delete t.fix;
      return t;
    };
    const draw = () => {
      ctx.main.innerHTML = `<div class="main-inner narrow-page">${head}
        <form id="yt-form" novalidate>
          ${aiPanel()}
          <section class="panel">
            <div class="field"><label for="yt-name">Name</label><input id="yt-name" name="name" maxlength="80" value="${esc(t.name)}" placeholder="e.g. Delivery checker works"><p class="hint">Shown in reports and alerts.</p></div>
            <div class="yt-grid">
              <div class="field"><label for="yt-sev">If it fails</label><select id="yt-sev" name="severity">${opt('critical', 'Critical: customers can’t buy', t.severity)}${opt('major', 'Major: something important is broken', t.severity)}${opt('minor', 'Minor: worth fixing', t.severity)}</select></div>
              <div class="field"><label for="yt-runs">When it runs</label><select id="yt-runs" name="runs">${opt('journeys', 'Every shopping check', t.runs)}${opt('full', 'Once a day, with the full check', t.runs)}</select></div>
              <div class="field"><label for="yt-dev">Device</label><select id="yt-dev" name="device">${opt('desktop', 'Computer', t.device)}${opt('mobile', 'Phone', t.device)}</select></div>
            </div>
            <div class="field"><label for="yt-fix">What to do when it fails <span class="muted" style="font-weight:400">(optional)</span></label><input id="yt-fix" name="fix" maxlength="300" value="${esc(t.fix || '')}" placeholder="e.g. Check the delivery app’s pincode list."></div>
            <label class="toggle-line"><span class="switch"><input type="checkbox" name="enabled" ${t.enabled === false ? '' : 'checked'}><span></span></span><span class="tl-text"><b>Run this test</b><span>Off keeps it in your file without running it.</span></span></label>
          </section>
          <section class="panel"><h2>Steps</h2><p class="sub">In order, like a shopper. Point at things by their text (<code>text=Check</code>), a button’s name (<code>role=button:Check</code>) or a CSS selector. Drag a step, or use the arrows, to move it.</p>
            <ol class="yt-steps" id="yt-steps">${t.steps.map(stepRow).join('')}</ol>
            <div class="inline-row"><button type="button" class="btn secondary small" id="yt-add" ${t.steps.length >= d.limits.steps ? 'disabled' : ''}>${icon('add', 15)}Add a step</button><span class="muted" style="font-size:12.5px">${t.steps.length} of ${d.limits.steps} steps</span></div>
          </section>
          <div class="yt-err" id="yt-err" role="alert"></div>
          <div class="inline-row yt-actions"><button type="submit" class="btn" id="yt-save">Save test</button><button type="button" class="btn secondary" id="yt-try">${icon('play', 15)}Try it now</button><a class="btn ghost" href="${base}">Cancel</a></div>
          <div id="yt-try-out"></div>
        </form></div>`;
      const form = $('#yt-form');
      form.addEventListener('input', () => { S.dirty = true; });
      form.addEventListener('change', (e) => { if (e.target.dataset.f === 'kind') { read(); const i = Number(e.target.closest('.yt-step').dataset.i); t.steps[i] = { [e.target.value]: lib[e.target.value].arg === 'flag' ? true : lib[e.target.value].arg === 'range' ? {} : '' }; S.dirty = true; draw(); $(`.yt-step[data-i="${i}"] [data-f=arg], .yt-step[data-i="${i}"] select`)?.focus(); } });
      const move = (from, to) => { read(); if (to < 0 || to >= t.steps.length) return; const [x] = t.steps.splice(from, 1); t.steps.splice(to, 0, x); S.dirty = true; draw(); $(`.yt-step[data-i="${to}"] select`)?.focus(); };
      form.addEventListener('click', (e) => {
        const up = e.target.closest('[data-up]'), down = e.target.closest('[data-down]'), rm = e.target.closest('[data-rm]');
        if (up) move(Number(up.dataset.up), Number(up.dataset.up) - 1);
        else if (down) move(Number(down.dataset.down), Number(down.dataset.down) + 1);
        else if (rm) { read(); if (t.steps.length === 1) return toast('A test needs at least one step.', 'error'); t.steps.splice(Number(rm.dataset.rm), 1); S.dirty = true; draw(); }
      });
      let dragFrom = null;
      $$('.yt-step', form).forEach((li) => {
        li.addEventListener('dragstart', (e) => { dragFrom = Number(li.dataset.i); li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop'); });
        li.addEventListener('dragleave', () => li.classList.remove('drop'));
        li.addEventListener('drop', (e) => { e.preventDefault(); li.classList.remove('drop'); if (dragFrom != null && dragFrom !== Number(li.dataset.i)) move(dragFrom, Number(li.dataset.i)); dragFrom = null; });
        // Typing in a field must not start a drag.
        $$('input, select', li).forEach((x) => { x.addEventListener('mousedown', () => (li.draggable = false)); x.addEventListener('blur', () => (li.draggable = true)); });
      });
      $('#yt-add').onclick = () => { read(); t.steps.push({ click: '' }); S.dirty = true; draw(); $$('.yt-step select').at(-1)?.focus(); };
      if (ai) {
        $('#yt-draft').onclick = async (e) => {
          ai.desc = $('#yt-desc').value; ai.page = $('#yt-page').value;
          const done = busy(e.currentTarget, 'Drafting');
          $('#yt-ai-out').innerHTML = '<p class="muted"><span class="spinner"></span> Opening your store and drafting the steps…</p>';
          try {
            const r = await api(`/api/stores/${s.id}/custom-tests/draft`, { method: 'POST', body: { description: ai.desc, page: ai.page } });
            const keep = { enabled: t.enabled, fix: t.fix };
            Object.assign(t, r.test, keep, { runs: t.runs });
            ai.left = r.left;
            ai.note = `Draft ready: ${r.test.steps.length} steps. Check them, press Try it now, then save.${r.note ? ` ${r.note}` : ''}`;
            S.dirty = true;
            draw();
            $('#yt-steps')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (ex) {
            done();
            if (ex.status === 429) ai.left = 0;
            $('#yt-ai-out').innerHTML = `<div class="notice fail-n"><p>${esc(ex.message)}</p></div>`;
          }
        };
      }
      form.onsubmit = async (e) => {
        e.preventDefault();
        read();
        const btn = $('#yt-save');
        const done = busy(btn, 'Saving');
        const list = tests.slice();
        list[idx] = t;
        try {
          await api(`/api/stores/${s.id}/custom-tests`, { method: 'PUT', body: { tests: list, format } });
          S.dirty = false;
          toast(`“${t.name}” saved`);
          location.hash = base;
        } catch (ex) { done(); $('#yt-err').innerHTML = `<div class="notice fail-n">${ytProblems(ex)}</div>`; }
      };
      $('#yt-try').onclick = async (e) => {
        read();
        const out = $('#yt-try-out');
        if (!t.name) { $('#yt-err').innerHTML = '<div class="notice fail-n"><p>Give the test a name first.</p></div>'; return; }
        const done = busy(e.currentTarget, 'Running');
        $('#yt-err').innerHTML = '';
        out.innerHTML = '<p class="muted"><span class="spinner"></span> Running this test on your store. It takes up to a minute…</p>';
        try {
          // Tried as it is in the form, before saving.
          const r = await ytRaw(`/api/stores/${s.id}/custom-tests/${encodeURIComponent(t.name)}/try`, { method: 'POST', text: JSON.stringify({ tests: [t] }) });
          out.innerHTML = ytTrail(await r.json());
          $$('.yt-shots img', out).forEach((im) => (im.onclick = () => lightbox(im.src, im.alt)));
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (ex) { out.innerHTML = `<div class="notice fail-n">${ytProblems(ex)}</div>`; } finally { done(); }
      };
    };
    draw();
  }

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
    const title = `${kindLabel(run)}${run.seq ? ` #${run.seq}` : ''}`;
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
    const radios = (name, map, val) => `<div class="seg" role="radiogroup">${Object.entries(map).map(([k, l]) => `<label ${belowPlan(name, k) ? `title="Not included in your plan" class="na"` : ''}><input type="radio" name="${name}" value="${k}" ${Number(k) === val ? 'checked' : ''} ${belowPlan(name, k) ? 'disabled' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
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
          <div class="controls"><div class="field"><label for="sl">Slack webhook URL <span class="muted" style="font-weight:400">(optional)</span></label><input id="sl" name="slack" placeholder="https://hooks.slack.com/services/…" value="${esc(s.slack_webhook || '')}" ${can('slack') ? '' : 'disabled'}>${can('slack') ? '' : `<p class="hint">${icon('lock', 12)} Slack alerts are in the ${esc(plansFor('slack'))} plans. <a href="#/account/billing">See plans</a></p>`}</div></div></div>
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
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (!ctx.alive()) return;
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Store settings')}<form class="settings-card" id="set">
      <div class="form-section"><div><h3>Store details</h3><p class="explain">The name is how this store appears in Tharam and in alerts.</p></div>
        <div class="controls"><div class="field"><label for="nm">Store name</label><input id="nm" name="name" value="${esc(s.name || '')}" required maxlength="80"></div>
        <div class="field"><label for="ad">Store address</label><input id="ad" value="${esc(s.url)}" readonly><p class="hint">To test a different address, add it as a new store.</p></div></div></div>
      <div class="form-section"><div><h3>Where you sell</h3><p class="explain">We add the checks for the laws in these countries, such as the German legal notice, EU cookie consent and US accessibility. Checks only; not legal advice.</p></div>
        <div class="controls"><div class="market-chips">${S.catalog.markets.map((m) => `<label class="mchip"><input type="checkbox" name="market" value="${m.code}" ${s.config.markets.includes(m.code) ? 'checked' : ''}><span>${esc(m.label)}</span></label>`).join('')}</div>
          <p class="hint" id="mk-hint"></p></div></div>
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
        const body = { name: fd.get('name'), config: { dailySales: fd.get('dailySales') || null, currency: fd.get('currency') || null, markets: fd.getAll('market') } };
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
    const packs = () => {
      const sel = $$('input[name=market]:checked', form).map((i) => i.value);
      const on = S.catalog.groups.filter((g) => g.markets?.some((m) => sel.includes(m))).map((g) => g.label);
      $('#mk-hint').innerHTML = on.length ? `Adds to your full check: ${on.map(esc).join(' · ')}. <a href="#/s/${s.id}/suite">Test suite</a>` : sel.length ? 'No extra legal checks for these countries yet. Your other checks still run.' : '';
    };
    $$('input[name=market]', form).forEach((i) => i.addEventListener('change', packs));
    packs();
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
          <span class="area-score">${a.rules ? `<span class="rules-met">${a.counts.pass} of ${a.checks.filter((x) => x.a && x.a !== 'skip').length} rules met</span>` : `${a.a ?? '–'}${b ? ` ${delta(a.a, a.b)}` : ''}`}</span>
          <span class="area-counts">${a.counts.pass ? `<span class="pill healthy">${a.counts.pass} passed</span>` : ''}${a.counts.warn ? `<span class="pill warning">${a.counts.warn} to check</span>` : ''}${a.counts.fail ? `<span class="pill critical">${a.counts.fail} failed</span>` : ''}${a.counts.skip ? `<span class="pill">${a.counts.skip} skipped</span>` : ''}</span>
          <span class="chev">${icon('chevron', 16)}</span></summary>
          <div class="table-wrap flat"><table class="data"><thead><tr><th style="width:84px">This report</th>${b ? '<th style="width:84px">Before</th>' : ''}<th>Check</th></tr></thead><tbody>
          ${a.checks.map((x) => `<tr data-check="${esc(x.id)}" class="${x.change === 'new' || x.change === 'worse' ? 'row-new' : x.change === 'fixed' ? 'row-fixed' : ''}"><td>${stat(x.a)}</td>${b ? `<td>${stat(x.b)}</td>` : ''}<td><span class="cell-main">${esc(x.title)}</span>${x.change === 'new' ? ' <span class="tag-new">New</span>' : x.change === 'fixed' ? ' <span class="tag-fixed">Fixed</span>' : ''}<div class="cell-sub">${esc(x.detail || x.prevDetail)}</div>${x.fix && (x.a === 'fail' || x.a === 'warn') ? `<div class="fix-line"><b>How to fix:</b> ${esc(x.fix)}</div>` : ''}${x.evidence?.screenshot ? `<div class="evidence"><button type="button" class="btn small secondary" data-shot="${esc(x.evidence.screenshot)}">${icon('image', 14)}Screenshot</button></div>` : ''}${x.evidence?.steps ? `<ol class="trail" style="margin:6px 0 0 18px;font-size:.88rem">${x.evidence.steps.map((st) => `<li class="${st.status === 'fail' ? 't-fail' : ''}">${esc(st.text)}${st.status === 'fail' ? ` · <b>failed</b>${st.error ? `: ${esc(st.error)}` : ''}` : ''}</li>`).join('')}</ol>` : ''}${x.evidence?.ai ? `<ul class="ai-findings" style="margin-left:0">${x.evidence.ai.map((f) => `<li><span class="sev ${f.severity === 'critical' ? 'fail' : f.severity === 'major' ? 'warn' : ''}">${esc(f.severity)}</span> ${esc(f.issue)} <span class="muted">(${esc(f.page)}, ${esc(f.device)})</span>${f.fix ? `<br><span class="fix-inline">Fix: ${esc(f.fix)}</span>` : ''}</li>`).join('')}</ul>` : ''}</td></tr>`).join('')}
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
    // One section at a time, as tabs: no long scrolling page. The chosen tab is remembered between reports.
    const issueCount = c.areas.reduce((n, a) => n + a.counts.fail + a.counts.warn, 0);
    const tabsList = [['changes', 'What changed', changes], ['areas', 'All checks', areas, issueCount], ['catalog', 'Products', catPanel], ['ai', 'AI review', aiPanel], ['speed', 'Speed', metrics], ['devices', 'Screenshots', visual], ['timings', 'Step timings', timings]].filter((x) => x[2]);
    if (S.focus) S.reportTab = 'areas';
    const cur = tabsList.some((x) => x[0] === S.reportTab) ? S.reportTab : tabsList[0]?.[0];
    const tabBar = `<nav class="rtabs no-print" role="tablist" aria-label="Report sections">${tabsList.map(([id, l, , n]) => `<button type="button" role="tab" data-rtab="${id}" aria-selected="${id === cur}">${esc(l)}${n ? `<span class="tab-count">${n}</span>` : ''}</button>`).join('')}</nav>`;
    const panes = tabsList.map(([id, , html]) => `<div class="rtab-pane" data-pane="${id}" role="tabpanel" ${id === cur ? '' : 'hidden'}>${html}</div>`).join('');
    ctx.main.innerHTML = `<div class="main-inner report-page">${storeHead(s, 'Reports', { actions: runButtons(s) })}${controls}${summary}${tabBar}${panes}</div>`;
    $$('[data-rtab]', ctx.main).forEach((b) => (b.onclick = () => {
      S.reportTab = b.dataset.rtab;
      $$('[data-rtab]', ctx.main).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $$('[data-pane]', ctx.main).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.rtab));
    }));
    if (S.focus) {
      const row = ctx.main.querySelector(`[data-check="${CSS.escape(S.focus)}"]`);
      S.focus = null;
      if (row) { row.closest('details').open = true; row.classList.add('flash'); setTimeout(() => row.scrollIntoView({ block: 'center' }), 50); }
    }

    const go = (runId, base) => (location.hash = `#/s/${s.id}/reports/${runId}/${base}`);
    $('#rep-run').onchange = (e) => go(e.target.value, /^\d+$/.test(baseParam) ? 'prev' : baseParam);
    $('#rep-base').onchange = (e) => go(run.id, e.target.value);
    $('#print').onclick = () => { $$('details', ctx.main).forEach((d) => (d.open = true)); const hidden = $$('[data-pane][hidden]', ctx.main); hidden.forEach((p) => (p.hidden = false)); window.print(); hidden.forEach((p) => (p.hidden = true)); };
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

  const BY = { manual: 'You', schedule: 'Daily check', ci: 'Deploy pipeline' };
  const ENV_KIND = { theme: ['Theme on this store', 'layers'], store: ['Staging store or site', 'globe'] };
  const hostOf = (u) => { try { const x = new URL(u); return x.hostname + (x.searchParams.get('preview_theme_id') ? ` · theme ${x.searchParams.get('preview_theme_id')}` : ''); } catch { return u; } };

  STORE_PAGES.publish = async (ctx, s) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (ctx.r.a && /^\d+$/.test(ctx.r.a)) return publishDetail(ctx, s, Number(ctx.r.a));
    if (!can('publish')) {
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Safe to publish')}${upsell('publish', 'Check every change before your customers see it', 'Test a new theme, sale banner or app change next to your live store, on computer, tablet and phone, and get a clear answer: safe to publish, have a look first, or don’t publish yet.')}</div>`;
      return;
    }
    const [d, ev, th] = await Promise.all([api(`/api/stores/${s.id}/releases`), api(`/api/stores/${s.id}/environments`), S.license?.shopify ? api(`/api/stores/${s.id}/shopify/themes`).catch(() => ({ themes: null, failed: true })) : Promise.resolve({ themes: null })]);
    if (!ctx.alive()) return;
    const shopify = !s.platform || /shopify/i.test(s.platform);
    const busyStore = !!s.active_run_id;
    const envs = ev.environments;

    const envRow = (e) => {
      const [kl, ki] = ENV_KIND[e.kind];
      const last = e.last ? `${pubPill(e.last)}<span class="cell-sub">${time(e.last.created_at)} · ${esc(BY[e.last.trigger] || 'You')}</span>` : '<span class="cell-sub">Not checked yet</span>';
      return `<li class="env" data-env="${e.id}"><span class="env-icon">${icon(ki, 18)}</span>
        <div class="env-main"><div class="env-name"><b>${esc(e.name)}</b>${e.auto === 'daily' ? '<span class="chip">Checked daily</span>' : ''}</div>
          <div class="cell-sub">${esc(kl)} · ${esc(hostOf(e.url))}</div></div>
        <div class="env-last">${last}</div>
        <div class="env-actions">
          ${e.last ? `<a class="icon-btn" href="#/s/${s.id}/publish/${e.last.id}" data-tip="Last result" aria-label="Open last result">${icon('reports', 17)}</a>` : ''}
          ${can('pipeline') ? `<button type="button" class="icon-btn" data-act="pipe" data-tip="Check from your deploy pipeline" aria-label="Deploy pipeline setup">${icon('code', 17)}</button>` : `<a class="icon-btn" href="#/account/billing" data-tip="Deploy pipeline checks: ${esc(plansFor('pipeline'))}" aria-label="Deploy pipeline checks are not in your plan">${icon('lock', 16)}</a>`}
          <button type="button" class="icon-btn" data-act="edit" data-tip="Edit" aria-label="Edit environment">${icon('edit', 17)}</button>
          <button type="button" class="icon-btn" data-act="del" data-tip="Remove" aria-label="Remove environment">${icon('trash', 17)}</button>
          <button type="button" class="btn small" data-act="run" ${busyStore ? 'disabled title="A test is running"' : ''}>${icon('play', 14)}Check now</button></div></li>`;
    };
    const envPanel = !can('environments') ? upsell('environments', 'Save your staging theme or staging store', 'Check it with one click or every day, and stop a bad update from your deploy pipeline.') : `<section class="panel"><div class="panel-head stack-sm"><div><h2>Environments</h2><p class="sub" style="margin:2px 0 0">Your staging themes and staging stores, saved once. Each check compares it with your live store.</p></div>
        <button type="button" class="btn secondary" id="env-add">${icon('add', 16)}Add environment</button></div>
      ${envs.length ? `<ul class="env-list">${envs.map(envRow).join('')}</ul>`
        : `<div class="env-empty"><p><b>Do you test changes somewhere before they go live?</b> Save it here, for example a <b>staging theme</b> your developer works on, a theme connected to GitHub, or a <b>separate staging store</b>. Then check it with one click, every day, or automatically after each deploy.</p></div>`}</section>`;

    const form = `<section class="panel pub-start">
      <div class="pub-intro"><span class="empty-icon">${icon('publish', 22)}</span><div><h2>Check a theme once</h2>
        <p class="sub">Paste a draft theme's preview link. We test it and your live theme at the same time, compare every check, screenshot and speed measure, and tell you if anything would break.</p></div></div>
      <form id="pubf" novalidate>
        <div class="pub-fields"><div class="field"><label for="purl">Theme preview link</label><input id="purl" name="url" placeholder="https://xxxx.shopifypreview.com" autocomplete="off" required></div>
        <div class="field"><label for="plabel">What changed <span class="muted" style="font-weight:400">(optional)</span></label><input id="plabel" name="label" placeholder="e.g. New Diwali homepage" maxlength="120"></div>
        <button class="btn" type="submit" ${busyStore ? 'disabled title="A test is running"' : ''}>${icon('play', 16)}Start check</button></div>
        <p class="error-msg" id="pub-err" role="alert"></p>
      </form>
      <details class="howto"><summary>Where do I find the preview link?</summary><ol>
        <li>In Shopify admin, open <b>Online Store → Themes</b>.</li>
        <li>Next to the draft theme, open the <b>⋯</b> menu and choose <b>Preview</b>.</li>
        <li>In the preview bar at the bottom, choose <b>Share preview</b> and copy the link.</li></ol>
        <p class="muted">Nothing is published and no orders are placed. The draft theme is only opened in our test browser. Shopify preview links stop working after 14 days, so copy a fresh one for older drafts.</p></details>
      ${shopify ? '' : '<div class="notice"><p>Theme preview links are a Shopify feature. For other platforms, add your staging site as an environment above.</p></div>'}</section>`;

    const list = d.releases.length ? `<section class="panel"><div class="panel-head"><h2>Earlier checks</h2></div>
      <div class="table-wrap flat"><table class="data"><thead><tr><th>Started</th><th>What was checked</th><th>Result</th><th>Findings</th><th aria-label="Open"></th></tr></thead><tbody>
      ${d.releases.map((r) => { const c = r.summary?.counts; const th = r.summary?.theme?.draft?.name; const what = r.environment?.name || th || 'Draft theme'; return `<tr class="link" data-href="#/s/${s.id}/publish/${r.id}" tabindex="0"><td><span class="cell-main">${time(r.created_at)}</span><div class="cell-sub">${esc(BY[r.trigger] || 'You')} · ${esc(exact(r.created_at))}</div></td>
        <td><span class="cell-main">${esc(what)}</span>${r.label || (r.environment && th) ? `<div class="cell-sub">${esc([r.environment && th, r.label].filter(Boolean).join(' · '))}</div>` : ''}</td><td>${pubPill(r)}</td>
        <td class="cell-sub">${c ? [c.blockers && plural(c.blockers, 'break'), c.reviews && plural(c.reviews, 'warning'), c.visual && `${plural(c.visual, 'page')} changed`, c.fixes && `${plural(c.fixes, 'fix', 'fixes')}`].filter(Boolean).join(' · ') || 'No differences' : esc(r.summary?.error || '–')}</td>
        <td class="go">${icon('right', 16)}</td></tr>`; }).join('')}</tbody></table></div></section>` : '';
    // Shopify app: the store's own draft themes, one click each. No preview links to copy.
    const themesPanel = th.themes ? `<section class="panel"><div class="panel-head"><div><h2>Your draft themes</h2><p class="sub" style="margin:2px 0 0">Check a theme before you publish it. We test it next to your live theme and tell you if anything would break.</p></div></div>
      ${th.themes.length ? `<ul class="env-list">${th.themes.map((t) => `<li class="env"><span class="env-icon">${icon('layers', 18)}</span><div class="env-main"><div class="env-name"><b>${esc(t.name)}</b>${t.role === 'DEVELOPMENT' ? '<span class="chip">Development</span>' : ''}</div><div class="cell-sub">Edited ${time(t.updatedAt)}</div></div><div></div>
        <div class="env-actions"><button type="button" class="btn small" data-theme="${esc(t.id)}" data-name="${esc(t.name)}" ${busyStore ? 'disabled title="A test is running"' : ''}>${icon('play', 14)}Check this theme</button></div></li>`).join('')}</ul>`
        : '<div class="env-empty"><p>You have no draft themes right now. Duplicate your live theme in <b>Online Store → Themes</b>, make your changes there, and check it here before publishing.</p></div>'}</section>` : th.failed ? '<div class="notice warn-n"><p>We couldn’t load your themes from Shopify just now. Reload the page to try again.</p></div>' : '';
    ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, 'Safe to publish')}${themesPanel}${envPanel}${th.themes ? `<details class="panel more-ways"><summary>Use a preview link instead</summary>${form}</details>` : form}${list}</div>`;
    $$('[data-theme]', ctx.main).forEach((b) => (b.onclick = async () => {
      const done = busy(b, 'Starting');
      try { const r = await api(`/api/stores/${s.id}/releases`, { method: 'POST', body: { themeId: b.dataset.theme, themeName: b.dataset.name } }); location.hash = `#/s/${s.id}/publish/${r.id}`; }
      catch (ex) { done(); toast(ex.message, 'error'); }
    }));
    $$('tr.link', ctx.main).forEach((tr) => { tr.onclick = () => (location.hash = tr.dataset.href); tr.onkeydown = (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; }; });
    $('#env-add').onclick = async () => { if (await envDialog(s)) render({ silent: true }); };
    $$('li.env', ctx.main).forEach((li) => {
      const e = envs.find((x) => x.id === Number(li.dataset.env));
      li.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'edit') { if (await envDialog(s, e)) render({ silent: true }); }
        else if (act === 'pipe') pipelineDialog(s, e);
        else if (act === 'del') {
          if (!(await confirmDialog({ title: `Remove ${e.name}?`, body: 'Earlier checks stay in your history. A deploy pipeline using this environment\'s key will stop working.', confirm: 'Remove', danger: true }))) return;
          await api(`/api/stores/${s.id}/environments/${e.id}`, { method: 'DELETE' });
          render({ silent: true });
        } else if (act === 'run') {
          const done = busy(b, 'Starting');
          try { const r = await api(`/api/stores/${s.id}/releases`, { method: 'POST', body: { environmentId: e.id } }); location.hash = `#/s/${s.id}/publish/${r.id}`; }
          catch (ex) { done(); toast(ex.message, 'error'); }
        }
      }));
    });
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

  function envDialog(s, e = null) {
    const kind = e?.kind || 'theme';
    const body = `<p>Save a place where changes are tested before they go live. We compare it with your live store.</p>
      <div class="field"><label for="env-name">Name</label><input id="env-name" name="name" maxlength="60" placeholder="e.g. Staging" value="${esc(e?.name || '')}" required></div>
      <fieldset class="field env-kinds"><legend>What is it?</legend>
        <label class="opt"><input type="radio" name="kind" value="theme" ${kind === 'theme' ? 'checked' : ''}><span><b>A theme on this store</b><small>A draft or staging theme, including one connected to GitHub. Use its Share preview link.</small></span></label>
        <label class="opt"><input type="radio" name="kind" value="store" ${kind === 'store' ? 'checked' : ''}><span><b>A separate staging store or site</b><small>Another Shopify store, a Hydrogen or headless preview, or a staging site on any platform.</small></span></label></fieldset>
      <div class="field"><label for="env-url" id="env-url-l"></label><input id="env-url" name="url" autocomplete="off" value="${esc(e?.url || '')}" required><p class="hint" id="env-url-h"></p></div>
      <div class="field" id="env-pw-f"><label for="env-pw">Storefront password <span class="muted" style="font-weight:400">(if it has one)</span></label><input id="env-pw" name="password" type="password" autocomplete="new-password" placeholder="${e?.hasPassword ? 'Saved. Type to replace it' : 'Leave empty if it has none'}"></div>
      <label class="check-line"><input type="checkbox" name="auto" ${e?.auto === 'daily' ? 'checked' : ''}><span>Check it every day and email me if something would break</span></label>`;
    return formDialog({
      title: e ? `Edit ${e.name}` : 'Add environment', body, submit: e ? 'Save' : 'Add environment',
      onOpen: (dl) => {
        const sync = () => {
          const k = dl.querySelector('input[name=kind]:checked').value;
          dl.querySelector('#env-url-l').textContent = k === 'theme' ? 'Theme preview link' : 'Address';
          dl.querySelector('#env-url').placeholder = k === 'theme' ? 'https://xxxx.shopifypreview.com' : 'https://staging-yourstore.myshopify.com';
          dl.querySelector('#env-url-h').textContent = k === 'theme' ? 'Online Store → Themes → ⋯ → Preview → Share preview. A theme connected to GitHub keeps the same link.' : 'The home page of the staging store or site.';
          dl.querySelector('#env-pw-f').hidden = k !== 'store';
        };
        dl.querySelectorAll('input[name=kind]').forEach((r) => (r.onchange = sync));
        sync();
      },
      onSubmit: (f) => {
        const body = { name: f.name.value, kind: f.kind.value, url: f.url.value, auto: f.auto.checked ? 'daily' : 'off' };
        if (f.password.value) body.password = f.password.value;
        return e ? api(`/api/stores/${s.id}/environments/${e.id}`, { method: 'PATCH', body }) : api(`/api/stores/${s.id}/environments`, { method: 'POST', body });
      },
    });
  }

  function pipelineDialog(s, e) {
    const base = location.origin;
    const curl = `curl -X POST ${base}/api/gate \\\n  -H "Authorization: Bearer ${e.token}"`;
    const yaml = `- name: Tharam publish check
  env:
    THARAM_KEY: \${{ secrets.THARAM_KEY }}
  run: |
    R=$(curl -s -X POST ${base}/api/gate -H "Authorization: Bearer $THARAM_KEY" \\
      -H "Content-Type: application/json" -d '{"label":"\${{ github.sha }}"}')
    ID=$(echo "$R" | jq -r .id)
    for i in $(seq 1 60); do
      sleep 10
      R=$(curl -s ${base}/api/gate/check/$ID -H "Authorization: Bearer $THARAM_KEY")
      [ "$(echo "$R" | jq -r .done)" = "true" ] && break
    done
    echo "$R" | jq -r '.headline, .report'
    [ "$(echo "$R" | jq -r .pass)" = "true" ]`;
    const body = `<p>If your developer deploys <b>${esc(e.name)}</b> with GitHub, Bitbucket or a script, a check can run after every deploy. The deploy stops when Tharam says <b>Don't publish yet</b>, and you get the side-by-side report.</p>
      <div class="field"><label>Key for ${esc(e.name)}</label><div class="copy-row"><code id="pk">${esc(e.token)}</code><button type="button" class="icon-btn bordered" data-copy="key" data-tip="Copy" aria-label="Copy key">${icon('copy', 16)}</button></div>
        <p class="hint">Treat it like a password. Anyone with it can start checks of this environment, nothing else.</p></div>
      <details class="howto" open><summary>GitHub Actions step</summary><p class="muted">Save the key as a repository secret named THARAM_KEY, then add this step after the step that deploys to ${esc(e.name)}.</p>
        <div class="code-box"><button type="button" class="icon-btn" data-copy="yaml" data-tip="Copy" aria-label="Copy step">${icon('copy', 16)}</button><pre>${esc(yaml)}</pre></div></details>
      <details class="howto"><summary>Any other tool</summary><p class="muted">Start a check, then read <code>/api/gate/check/&lt;id&gt;</code> until <code>done</code> is true. <code>pass</code> is false when something would break. To check a new theme, send <code>{"url": "&lt;preview link&gt;"}</code>.</p>
        <div class="code-box"><button type="button" class="icon-btn" data-copy="curl" data-tip="Copy" aria-label="Copy command">${icon('copy', 16)}</button><pre>${esc(curl)}</pre></div></details>
      <p style="margin-top:14px"><button type="button" class="btn small secondary" data-rotate>Make a new key</button> <span class="muted">The old key stops working.</span></p>`;
    formDialog({ title: 'Check from your deploy pipeline', body, wide: true, cancel: 'Done',
      onOpen: (dl) => {
        const vals = { key: () => e.token, yaml: () => yaml.replaceAll(e.token, e.token), curl: () => curl };
        dl.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copyText(vals[b.dataset.copy]())));
        dl.querySelector('[data-rotate]').onclick = async (ev) => {
          if (!(await confirmDialog({ title: 'Make a new key?', body: 'Pipelines using the current key stop working until you update them.', confirm: 'Make new key', danger: true }))) return;
          const n = await api(`/api/stores/${s.id}/environments/${e.id}/token`, { method: 'POST' });
          dl.close(); pipelineDialog(s, n);
        };
      } });
  }

  async function publishDetail(ctx, s, rid) {
    const r = await api(`/api/stores/${s.id}/releases/${rid}`);
    if (!ctx.alive()) return;
    const sum = r.summary;
    const crumb = `<a href="#/s/${s.id}/publish">Safe to publish</a> / Check${r.seq ? ` #${r.seq}` : ''}`;
    const title = r.environment?.name || sum?.theme?.draft?.name || r.label || 'Draft theme';
    const meta = `${[r.environment && sum?.theme?.draft?.name, r.label && (r.environment || sum?.theme?.draft?.name) ? r.label : null].filter(Boolean).map((x) => `<span>${esc(x)}</span><span class="sep"></span>`).join('')}<span>Started ${esc(exact(r.created_at))}${r.trigger && r.trigger !== 'manual' ? ` · ${esc(BY[r.trigger])}` : ''}</span>${r.finished_at ? `<span class="sep"></span><span>took ${duration(r.created_at, r.finished_at)}</span>` : ''}`;
    const preview = `<a class="icon-btn bordered" href="${esc(r.preview_url)}" target="_blank" rel="noopener" data-tip="Open what was checked" aria-label="Open what was checked">${icon('external', 17)}</a>`;

    if (r.status === 'running') {
      const row = (label, run) => {
        if (!run) return '';
        const st = liveState({ ...run, kind: 'full' });
        const what = run.status === 'done' ? 'Finished' : st.queued ? 'Waiting to start' : `${st.current.label} · step ${st.idx + 1} of ${st.phases.length}`;
        return `<div class="pub-run"><div class="pub-run-head"><b>${esc(label)}</b><span class="muted">${esc(what)}</span>${run.status === 'done' ? `<span class="t-pass">${icon('check', 16)}</span>` : '<span class="spinner"></span>'}</div>
          <div class="progress"><i style="width:${run.status === 'done' ? 100 : st.pct}%"></i></div>${run.live ? `<p class="live-tally">${tally(run.live.counts)}</p>` : ''}</div>`;
      };
      ctx.main.innerHTML = `<div class="main-inner">${storeHead(s, title, { crumb, meta, actions: preview + `<button type="button" class="btn danger" id="pub-stop">${icon('stop', 16)}Stop</button>` })}
        <section class="panel run-live"><div class="rl-head"><span class="spinner"></span><div><h2>Testing live and ${esc(r.environment?.name || 'the draft')} side by side</h2><p>Usually takes 1 to 3 minutes. This page updates by itself.</p></div></div></section>
        <div class="grid-2 run-live-grid"><section class="panel">${row(r.environment?.kind === 'store' ? 'Live store' : 'Live theme', r.runs.live)}</section><section class="panel">${row(r.environment?.name || 'Draft theme', r.runs.draft)}</section></div></div>`;
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

    const cand = r.environment?.name || 'the draft';
    const candCap = r.environment?.name || 'Draft';
    const [vLabel, vKey] = PUB[r.verdict];
    const icn = { safe: 'check', review: 'alerts', blocked: 'stop' }[r.verdict];
    const hero = `<section class="panel pub-verdict ${vKey}">
      <span class="pv-icon">${icon(icn, 26)}</span>
      <div class="pv-text"><p class="pv-kicker">${esc(vLabel)}</p><h2>${esc(sum.headline)}</h2>
        <p class="muted">${esc(r.environment?.kind === 'store' ? r.environment.name : sum.theme?.draft?.name || 'Draft')} compared with ${esc(r.environment?.kind === 'store' ? 'your live store' : sum.theme?.live?.name || 'your live theme')} on desktop, tablet and phone.</p></div>
      <div class="pv-scores"><div><span>Live</span><b>${sum.scores?.live ?? '–'}</b></div><span class="pv-arrow">${icon('arrow', 18)}</span><div><span>${r.environment?.kind === 'store' ? 'Staging' : 'Draft'}</span><b class="${(sum.scores?.draft ?? 0) < (sum.scores?.live ?? 0) - 5 ? 't-fail' : ''}">${sum.scores?.draft ?? '–'}</b></div></div></section>`;
    const findRow = (x, kind) => `<li><div class="row"><span class="sev ${kind === 'fix' ? 'ok' : x.status === 'fail' ? 'fail' : 'warn'}">${kind === 'fix' ? 'Fixed' : x.status === 'fail' ? 'Breaks' : 'Check'}</span>
      <span><span class="t">${esc(x.title)}</span><span class="d">${esc(kind === 'fix' ? `On live: ${x.liveDetail}` : x.detail)}</span>
      ${kind !== 'fix' && x.liveDetail ? `<span class="pub-live">On live: ${esc(x.liveDetail)}</span>` : ''}
      ${kind !== 'fix' && x.fix ? `<div class="fix-line"><b>How to fix:</b> ${esc(x.fix)}</div>` : ''}
      ${x.evidence?.screenshot ? `<div class="evidence"><button type="button" class="btn small secondary" data-shot="${esc(x.evidence.screenshot)}">${icon('image', 14)}Screenshot</button></div>` : ''}</span><span></span></div></li>`;
    const breaks = [...sum.blockers, ...sum.reviews];
    const findings = `<div class="grid-2 tight"><section class="panel"><h2>Breaks or changes on ${esc(cand)}</h2><p class="sub">Works on your live store, but not on ${esc(cand)}.</p>
        ${breaks.length ? `<ul class="list">${breaks.map((x) => findRow(x, 'break')).join('')}</ul>` : `<p class="muted" style="margin:0">Nothing breaks on ${esc(cand)}.</p>`}</section>
      <section class="panel"><h2>Fixed by ${esc(cand)}</h2><p class="sub">Problems on your live store that ${esc(cand)} fixes.</p>
        ${sum.fixes.length ? `<ul class="list">${sum.fixes.map((x) => findRow(x, 'fix')).join('')}</ul>` : `<p class="muted" style="margin:0">No live problems are fixed by ${esc(cand)}.</p>`}</section></div>`;
    const cmp = r.compare || { visual: [], metrics: [], areas: [] };
    const DEV = [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Phone']].filter(([dv]) => cmp.visual.some((v) => v.key.endsWith(dv)));
    const visual = cmp.visual.length ? `<section class="panel"><div class="panel-head"><h2>How ${esc(cand)} looks</h2>
        <div class="seg" role="radiogroup" aria-label="Device">${DEV.map(([dv, l], i) => `<label><input type="radio" name="pdev" value="${dv}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
        <p class="sub">${esc(candCap)} and live screenshots of the same page. Difference shows changed pixels in red.</p><div class="shots" id="pub-shots"></div></section>` : '';
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
        const views = [['a', candCap, v.a], ['b', 'Live', v.b], ['diff', 'Difference', v.diff]].filter((x) => x[2]);
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

  // ---------- First-time onboarding: welcome, your store, alerts, first check ----------
  const ONB_STEPS = ['Welcome', 'Your store', 'Alerts and schedule', 'First check'];
  STORE_PAGES.welcome = async (ctx, s) => {
    S.catalog = S.catalog || (await api('/api/catalog'));
    if (!ctx.alive()) return;
    const o = (S.onb = S.onb?.store === s.id ? S.onb : { store: s.id, step: 0, found: null, markets: [...s.config.markets], testProduct: s.config.testProduct || '', email: s.alert_email || S.me.email, journeyIntervalMin: s.config.journeyIntervalMin, fullIntervalMin: s.config.fullIntervalMin, dailySales: s.config.dailySales || '', currency: s.config.currency || '' });
    const name = esc(s.name || host(s.url));
    const stepper = `<ol class="onb-steps">${ONB_STEPS.map((t, i) => `<li class="${i < o.step ? 'done' : i === o.step ? 'now' : ''}"><span>${i < o.step ? icon('check', 13) : i + 1}</span>${esc(t)}</li>`).join('')}</ol>`;
    const wrap = (inner, actions) => { ctx.main.innerHTML = `<div class="main-inner onb">${stepper}<section class="panel onb-card">${inner}</section>${actions ? `<div class="onb-actions">${actions}</div>` : ''}</div>`; };
    const go = (n) => { o.step = n; render({ silent: true }); };

    if (o.step === 0) {
      wrap(`<div class="onb-hero"><span class="onb-mark">${icon('shield', 26)}</span><div><h1>Welcome to Tharam</h1><p class="lede-sm">Let’s make sure customers can always buy from <b>${name}</b>. Setup takes about two minutes.</p></div></div>
        <div class="onb-three">
          <div><span>${icon('play', 18)}</span><b>We shop your store like a customer</b><p>Every few hours, on a phone and a computer: search, pick a size, add to cart and go to checkout.</p></div>
          <div><span>${icon('alerts', 18)}</span><b>We tell you when something breaks</b><p>One email when buying stops working, with what broke and how to fix it. One more when it’s fixed.</p></div>
          <div><span>${icon('publish', 18)}</span><b>We check changes before customers see them</b><p>New themes, price imports and discount codes, checked before they cost you sales.</p></div></div>
        <ul class="onb-promises"><li>${icon('check', 14)}No orders are ever placed</li><li>${icon('check', 14)}Your theme is never changed</li><li>${icon('check', 14)}We only read your store, never edit it</li></ul>`,
        `<span></span><button class="btn" id="n">Set up my store ${icon('arrow', 16)}</button>`);
      $('#n').onclick = () => go(1);
      return;
    }

    if (o.step === 1) {
      const f = o.found;
      const looking = !f;
      const locked = f?.locked && !f.unlocked;
      wrap(`<h2>Your store</h2><p class="sub">We looked at ${name} the way a shopper would.</p>
        ${looking ? `<div class="onb-looking"><span class="spinner"></span>Looking at your store…</div>` : f.error ? `<div class="notice warn-n"><p>${esc(f.error)}</p></div>` : `
        <dl class="found"><div><dt>Store</dt><dd>${esc(host(s.url))}</dd></div><div><dt>Platform</dt><dd>${esc(f.platform?.label || 'Shopify')}</dd></div><div><dt>Products</dt><dd>${locked ? 'After the password' : f.productCount ? `${f.productCount >= 50 ? '50+' : f.productCount} found` : '–'}</dd></div></dl>
        ${f.locked ? `<div class="onb-block ${locked ? 'need' : 'ok'}"><h3>${locked ? `${icon('lock', 16)} Your store has a password` : `${icon('check', 16)} Password works`}</h3>
          ${locked ? `<p>Shoppers (and our test browser) need it to see your store. Find it in Shopify under <b>Online Store → Preferences → Password protection</b>.</p>
          <form id="pwf" class="inline-row" novalidate><input name="password" type="password" autocomplete="off" placeholder="Storefront password" aria-label="Storefront password" required><button class="btn secondary" type="submit">Check password</button></form><p class="error-msg" id="pw-err" role="alert"></p>` : '<p>We’ll use it only to open your store for testing, and never show it again.</p>'}</div>` : ''}
        <div class="onb-block"><h3>Where do you sell?</h3><p>We add checks for the rules in these countries, like legal pages, cookie consent and accessibility.</p>
          <div class="market-chips">${S.catalog.markets.map((m) => `<label class="mchip"><input type="checkbox" name="market" value="${m.code}" ${o.markets.includes(m.code) ? 'checked' : ''}><span>${esc(m.label)}</span></label>`).join('')}</div></div>
        ${f.catalog?.length ? `<div class="onb-block"><h3>Product used in tests</h3><p>Each test adds one to a fresh cart and goes to checkout, then empties the cart. Pick something usually in stock.</p>
          <select id="tp"><option value="">Choose automatically (recommended)</option>${f.catalog.map((p) => `<option value="${esc(p.handle)}" ${p.handle === o.testProduct ? 'selected' : ''}>${esc(p.title)}${p.variants > 1 ? ` (${p.variants} variants)` : ''}</option>`).join('')}</select></div>` : ''}`}`,
        `<button class="btn ghost" id="b">Back</button><button class="btn" id="n" ${looking || locked ? 'disabled' : ''}>Continue ${icon('arrow', 16)}</button>`);
      $('#b').onclick = () => go(0);
      if (looking) {
        api(`/api/stores/${s.id}/discover`, { method: 'POST' }).then((d) => { o.found = d.reachable === false ? { error: d.error } : d; if (o.found.locked && !o.found.wrongPassword && s.has_password) o.found.unlocked = true; }).catch((e) => { o.found = { error: e.message }; }).finally(() => { if (ctx.alive()) render({ silent: true }); });
        return;
      }
      $$('input[name=market]', ctx.main).forEach((i) => (i.onchange = () => { o.markets = $$('input[name=market]:checked', ctx.main).map((x) => x.value); }));
      $('#tp')?.addEventListener('change', (e) => (o.testProduct = e.target.value));
      $('#pwf')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = e.target.password.value;
        if (!pw) { $('#pw-err').textContent = 'Enter the storefront password.'; return; }
        const done = busy(e.target.querySelector('button'), 'Checking');
        try {
          await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { password: pw } });
          const d = await api(`/api/stores/${s.id}/discover`, { method: 'POST' });
          if (d.wrongPassword || (d.locked && !d.productCount)) { done(); $('#pw-err').textContent = 'That password didn’t open your store. Check it and try again.'; return; }
          o.found = { ...d, locked: true, unlocked: true };
          await loadStores();
          render({ silent: true });
        } catch (ex) { done(); $('#pw-err').textContent = ex.message; }
      });
      $('#n').onclick = async (e) => {
        const done = busy(e.currentTarget, 'Saving');
        try { await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { markets: o.markets, testProduct: o.testProduct || null } } }); await loadStores(); go(2); }
        catch (ex) { done(); toast(ex.message, 'error'); }
      };
      return;
    }

    if (o.step === 2) {
      const radios = (nm, map, val) => `<div class="seg" role="radiogroup">${Object.entries(map).map(([k, l]) => `<label ${belowPlan(nm, k) ? 'class="na" title="Not included in your plan"' : ''}><input type="radio" name="${nm}" value="${k}" ${Number(k) === Number(val) ? 'checked' : ''} ${belowPlan(nm, k) ? 'disabled' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
      wrap(`<h2>Alerts and schedule</h2><p class="sub">Where we tell you about problems, and how often we check. You can change all of this later.</p>
        <form id="af" novalidate>
        <div class="onb-block"><h3>Send alerts to</h3><input id="ae" name="email" type="email" value="${esc(o.email)}" required autocomplete="email"><p class="hint">One email when something breaks, one when it’s fixed. Never the same problem twice.</p></div>
        <div class="onb-block"><h3>Shopping checks</h3><p>We search, add to cart and open checkout.</p>${radios('journeyIntervalMin', EVERY, o.journeyIntervalMin)}</div>
        <div class="onb-block"><h3>Full check</h3><p>Everything else: every product and price, speed, Google, design and the rules where you sell.</p>${radios('fullIntervalMin', FULL_EVERY, o.fullIntervalMin)}</div>
        <div class="onb-block"><h3>Average daily sales <span class="muted" style="font-weight:400">(optional)</span></h3><p>Lets us show how much money was at risk when customers couldn’t buy. Only you see it.</p>
          <div class="inline-row"><input name="dailySales" type="number" min="0" inputmode="numeric" value="${esc(o.dailySales)}" placeholder="e.g. 50000" style="max-width:200px"><span class="muted">${esc(o.currency || '')}</span></div></div>
        <p class="error-msg" id="af-err" role="alert"></p></form>`,
        `<button class="btn ghost" id="b">Back</button><button class="btn" id="n">Continue ${icon('arrow', 16)}</button>`);
      const f = $('#af');
      const save = () => { const fd = new FormData(f); o.email = String(fd.get('email') || '').trim(); o.journeyIntervalMin = Number(fd.get('journeyIntervalMin')) || o.journeyIntervalMin; o.fullIntervalMin = Number(fd.get('fullIntervalMin')) || o.fullIntervalMin; o.dailySales = fd.get('dailySales'); };
      $('#b').onclick = () => { save(); go(1); };
      $('#n').onclick = async (e) => {
        save();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email)) { $('#af-err').textContent = 'Enter a valid email for alerts.'; return; }
        const done = busy(e.currentTarget, 'Saving');
        try { await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { alertEmail: o.email, monitoring: true, config: { journeyIntervalMin: o.journeyIntervalMin, fullIntervalMin: o.fullIntervalMin, dailySales: o.dailySales || null } } }); await loadStores(); go(3); }
        catch (ex) { done(); $('#af-err').textContent = ex.message; }
      };
      return;
    }

    // Step 3: what the first check will do, then start it.
    const g = S.catalog.groups.filter((x) => !s.config.disabled.includes(x.key) && groupAllowed(x) && inMarket(x, s.config.markets) && (!x.ai || S.catalog.aiEnabled));
    const has = (k) => g.some((x) => x.key === k);
    const items = [
      ['Shop your store on a phone and a computer', 'Search, product page, size, add to cart, cart and checkout. We stop before payment.'],
      has('speed') && ['Measure speed and how Google sees you', 'Load time on phones, page titles, broken links and accessibility.'],
      has('catalog') && ['Check every product', 'Prices of zero, fake discounts, unfinished descriptions and missing photos.'],
      s.config.markets.length && g.some((x) => x.markets) && ['Check the rules where you sell', S.catalog.groups.filter((x) => x.markets && g.includes(x)).map((x) => x.label).join(' · ')],
      has('visual') && ['Save today’s look', 'Screenshots we compare against, so you hear about unexpected design changes.'],
    ].filter(Boolean);
    wrap(`<h2>Your first check</h2><p class="sub">It takes ${estimate(g.map((x) => x.key))}. You can watch it happen.</p>
      <ul class="onb-plan">${items.map(([t, d]) => `<li><span>${icon('check', 14)}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')}</ul>
      <div class="onb-after"><b>After that</b><p>Shopping checks ${esc((EVERY[s.config.journeyIntervalMin] || '').toLowerCase())}, a full check ${esc((FULL_EVERY[s.config.fullIntervalMin] || '').toLowerCase())}, and alerts to ${esc(s.alert_email || o.email)}.</p></div>`,
      `<button class="btn ghost" id="b">Back</button><button class="btn" id="n">${icon('play', 16)}Start my first check</button>`);
    $('#b').onclick = () => go(2);
    $('#n').onclick = async (e) => {
      const done = busy(e.currentTarget, 'Starting');
      try {
        await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { onboarded: true } } });
        const r = await api(`/api/stores/${s.id}/run`, { method: 'POST', body: {} });
        S.onb = null;
        await loadStores();
        location.hash = `#/s/${s.id}/runs/${r.runId}`;
      } catch (ex) { done(); toast(ex.message, 'error'); }
    };
  };

  // ---------- The first-report tour ----------
  function startTour(s) {
    S.touring = true;
    const steps = [
      { el: '[data-tour=hero]', title: 'Your store at a glance', text: '“Customers can buy” is what matters most. The number is your store’s health: problems that cost sales lower it. Open the report for every detail and screenshot.' },
      { el: '[data-tour=scorecard]', title: 'Your scorecard', text: 'How often customers could buy, how fast problems got fixed, and how much money was at risk. It builds up with every check.' },
      { el: '[data-tour=fix]', title: 'What needs fixing', text: 'Each problem says what’s wrong and exactly how to fix it, most important first. Click one to see it in the report.' },
      { el: '[data-tour=run]', title: 'Check any time', text: 'We check on our own, but you can run a check now: a quick shopping test, your full suite, or a sale readiness check before a big sale.' },
      { title: 'Before you change your design', text: `Use <b>Safe to publish</b> in the ${EMB ? 'Tharam menu in Shopify’s sidebar' : 'menu on the left'}. Pick your draft theme and we tell you if anything would break, before your customers see it.` },
      { title: 'You’re all set', text: `We’ll keep checking ${esc(s.name || host(s.url))} and email you only when something breaks or is fixed. The guide in ${EMB ? 'the Tharam menu' : 'the menu'} explains everything else.` },
    ];
    let i = 0;
    const layer = document.createElement('div');
    layer.className = 'tour';
    document.body.appendChild(layer);
    const finish = async () => {
      layer.remove(); window.removeEventListener('resize', draw); S.touring = false;
      await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { toured: true } } }).catch(() => {});
      await loadStores().catch(() => {});
    };
    function draw() {
      const st = steps[i];
      const target = st.el && document.querySelector(st.el);
      if (target) target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = target?.getBoundingClientRect();
      const hole = r ? `<div class="tour-hole" style="top:${r.top - 6}px;left:${r.left - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>` : '<div class="tour-dim"></div>';
      const below = r && r.bottom + 220 < window.innerHeight;
      const pos = r ? `top:${below ? r.bottom + 14 : Math.max(12, r.top - 14)}px;left:${Math.min(Math.max(12, r.left), window.innerWidth - 372)}px;${below ? '' : 'transform:translateY(-100%);'}` : 'top:50%;left:50%;transform:translate(-50%,-50%);';
      layer.innerHTML = `${hole}<div class="tour-pop" role="dialog" aria-label="${esc(st.title)}" style="${pos}">
        <p class="tour-k">${i + 1} of ${steps.length}</p><h3>${esc(st.title)}</h3><p>${st.text}</p>
        <div class="tour-actions"><button type="button" class="btn ghost small" data-t="skip">${i === steps.length - 1 ? '' : 'Skip tour'}</button><span>${i ? '<button type="button" class="btn secondary small" data-t="back">Back</button>' : ''}<button type="button" class="btn small" data-t="next">${i === steps.length - 1 ? 'Done' : 'Next'}</button></span></div></div>`;
      layer.querySelector('[data-t=next]').focus();
      layer.querySelector('[data-t=next]').onclick = () => { if (i === steps.length - 1) return finish(); i++; draw(); };
      layer.querySelector('[data-t=back]')?.addEventListener('click', () => { i--; draw(); });
      layer.querySelector('[data-t=skip]').onclick = finish;
    }
    window.addEventListener('resize', draw);
    setTimeout(draw, 150);
  }

  // ---------- How to use Tharam ----------
  PAGES.guide = async (ctx) => {
    const s = S.stores.find((x) => x.id === S.storeId) || S.stores[0];
    const base = s ? `#/s/${s.id}` : '#/';
    const menu = EMB ? 'the Tharam menu in Shopify’s sidebar' : 'the menu on the left';
    const card = (ic, t, d, links) => `<section class="panel guide-card"><span class="g-ic">${icon(ic, 20)}</span><div><h2>${esc(t)}</h2><p>${d}</p>${links ? `<p class="g-links">${links}</p>` : ''}</div></section>`;
    ctx.main.innerHTML = `<div class="main-inner"><div class="page-head"><div><div class="crumbs">Help</div><h1>How to use Tharam</h1><div class="meta">Everything is in ${esc(menu)}.</div></div>
        ${s ? '<div class="actions"><button type="button" class="btn secondary" id="resetup">Go through setup again</button><button type="button" class="btn secondary" id="replay">Show me around again</button></div>' : ''}</div>
      <div class="guide-grid">
      ${card('monitoring', 'Every day: nothing to do', 'We shop your store like a customer on our own schedule and email you only when something breaks or is fixed. Open <b>Overview</b> any time to see whether customers can buy, your scorecard and what needs fixing.', s ? `<a href="${base}">Overview</a> · <a href="${base}/monitoring">Change how often</a>` : '')}
      ${card('alerts', 'When you get an alert', 'The email says what broke, the likely cause and how to fix it, with a link to the report and screenshots. Fix it, and we’ll confirm on the next check, or click Run validations to check straight away.', s ? `<a href="${base}/alerts">Alerts and where they go</a>` : '')}
      ${card('play', 'Check right now', '<b>Run validations</b> on the Overview: choose a quick shopping test, your full suite, a sale readiness check, or pick checks yourself. Watch it live, and stop it any time.', s ? `<a href="${base}/run">Run validations</a>` : '')}
      ${card('publish', 'Before you change your design', 'Duplicate your live theme in Shopify, make your changes there, then open <b>Safe to publish</b> and click Check this theme. We test it next to your live theme on phone, tablet and computer, and tell you if anything would break.', s ? `<a href="${base}/publish">Safe to publish</a>` : '')}
      ${card('catalog', 'Products, prices and discount codes', 'Every full check looks at every product for wrong prices, fake discounts, unfinished text and missing photos. When you change products in Shopify, we check them within minutes. Your active discount codes are tested too.', s ? `<a href="${base}/catalog">Products</a> · <a href="${base}/suite/codes">Discount codes</a>` : '')}
      ${card('reports', 'Reports', 'Every check is saved with screenshots. Compare any two to see what broke, what got fixed and what changed. Print or save any report as a PDF to share.', s ? `<a href="${base}/reports">Reports</a>` : '')}
      ${card('suite', 'Choose what we check', '<b>Test suite</b> switches checks on or off, sets the product used in tests, and holds your sale discount codes. <b>Settings</b> has where you sell, your daily sales and the storefront password.', s ? `<a href="${base}/suite">Test suite</a> · <a href="${base}/settings">Settings</a>` : '')}
      ${card('shield', 'What we never do', 'We never place orders, never change your theme, products or settings, and never see your customers’ details. We only read your store.', '')}
      </div>
      <p class="muted center" style="margin-top:20px">Questions? Write to <a href="mailto:hello@tharam.store">hello@tharam.store</a>. A person reads every email.</p></div>`;
    $('#resetup')?.addEventListener('click', async () => {
      await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { onboarded: false, toured: false } } });
      S.onb = null;
      await loadStores();
      location.hash = `${base}/welcome`;
    });
    $('#replay')?.addEventListener('click', async () => {
      await api(`/api/stores/${s.id}`, { method: 'PATCH', body: { config: { toured: false } } });
      await loadStores();
      location.hash = base;
    });
  };

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
    ctx.main.innerHTML = `<div class="main-inner"><div class="page-head"><div><div class="crumbs">Workspace</div><h1>All stores</h1><div class="meta">${d.stores.length} of ${S.license.maxStores} store${S.license.maxStores === 1 ? '' : 's'} on your ${esc(S.license.plan.name)} plan · <a href="#/account/billing">Plan and billing</a></div></div><div class="actions">${addStoreBtn()}</div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Store</th><th>Status</th><th class="num">Buyability, 7 days</th><th class="num">Health</th><th>Last test</th><th>Next test</th><th aria-label="Open"></th></tr></thead><tbody>
      ${d.stores.map((s) => { const st = storeStatus(s); return `<tr class="link" data-href="#/s/${s.id}" tabindex="0"><td><div class="cell-main">${esc(s.name || host(s.url))}</div><div class="cell-sub">${esc(host(s.url))}${s.platform ? ` · ${esc(s.platform)}` : ''}</div></td>
        <td><span class="status-inline"><span class="dot ${esc(st.key)}"></span>${esc(st.label)}</span>${s.failing.length ? `<div class="cell-sub">${s.failing.length} open problem${s.failing.length > 1 ? 's' : ''}</div>` : ''}</td>
        <td class="num"><b>${s.buyability_week == null ? '–' : s.buyability_week + '%'}</b></td><td class="num">${s.last_score ?? '–'}</td><td>${s.last_run_at ? time(s.last_run_at) : '<span class="muted">Not yet</span>'}</td><td class="cell-sub">${s.active_run_id ? 'Running now' : s.monitoring && s.last_run_at ? esc(inMin(s.next_run_in)) : s.monitoring ? 'After first check' : 'Paused'}</td><td class="go">${icon('right', 16)}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${d.alerts.length ? `<section class="panel" style="margin-top:20px"><h2>Latest alerts across stores</h2><ul class="list" style="margin-top:10px">${d.alerts.slice(0, 8).map((a) => `<li><a class="row" href="#/s/${a.store_id}/alerts"><span class="sev ${a.state === 'failing' ? 'fail' : 'ok'}">${a.state === 'failing' ? 'Broke' : 'Fixed'}</span><span><span class="t">${esc(a.store_name || host(a.store_url))}</span><span class="d">${esc(a.message || a.check_id)}</span></span><span class="r">${time(a.created_at)}</span></a></li>`).join('')}</ul></section>` : ''}</div>`;
    $$('tr.link', ctx.main).forEach((tr) => { tr.onclick = () => (location.hash = tr.dataset.href); tr.onkeydown = (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; }; });
    if (d.stores.some((s) => s.active_run_id)) poll(5000);
  };

  // Browser access for a store that installed from Shopify. Optional: everything also works inside Shopify.
  async function webAccessPanel(el) {
    const d = await api('/api/account/web-access');
    const draw = (sent) => {
      el.innerHTML = `<div class="form-section"><div><h3>Use Tharam in a browser</h3><p class="explain">Everything works here in Shopify. If you'd also like Tharam in a browser, to share reports with your developer or check from your phone, add your email. You'll sign in at tharam.store with a link we email you; there's no password.</p></div>
        <div class="controls">${d.email && !sent ? `<div class="field"><label>Signs in with</label><p style="margin:0"><b>${esc(d.email)}</b></p><p class="hint">Sign in at <a href="/app" target="_blank" rel="noopener">tharam.store/app</a> and choose "Email me a sign-in link".</p></div>
          <div class="inline-row"><button type="button" class="btn secondary" id="wa-change">Change email</button><button type="button" class="btn link danger" id="wa-off">Turn off browser access</button></div>`
        : sent ? `<div class="notice"><p><b>Check ${esc(sent)}.</b> We sent a link to confirm it. Open it within 30 minutes to finish; until then nothing changes.</p></div><div><button type="button" class="btn link" id="wa-change">Use a different email</button></div>`
        : `<form id="wa-form" class="inline-row" novalidate><input name="email" type="email" placeholder="you@yourstore.com" aria-label="Email for browser sign-in" required><button class="btn" type="submit">Send confirmation link</button></form>`}
          <p class="error-msg" id="wa-err" role="alert"></p></div></div>`;
      $('#wa-change', el)?.addEventListener('click', () => { d.email = null; draw(); });
      $('#wa-off', el)?.addEventListener('click', async (e) => {
        const done = busy(e.currentTarget, 'Turning off');
        try { await api('/api/account/web-access', { method: 'DELETE' }); d.email = null; toast('Browser access is off. Any browser that was signed in has been signed out.'); draw(); }
        catch (ex) { done(); $('#wa-err', el).textContent = ex.message; }
      });
      $('#wa-form', el)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = new FormData(e.currentTarget).get('email');
        const done = busy(e.currentTarget.querySelector('button'), 'Sending');
        try { const r = await api('/api/account/web-access', { method: 'POST', body: { email } }); draw(r.sentTo); }
        catch (ex) { done(); $('#wa-err', el).textContent = ex.message; }
      });
    };
    draw();
  }

  PAGES.account = async (ctx) => {
    const tab = ['password', 'billing'].includes(ctx.r.a) ? ctx.r.a : null;
    const head = `<div class="page-head"><div><div class="crumbs">Workspace</div><h1>Account</h1><div class="meta">${esc(S.me.email)}</div></div></div>` + tabs('#/account', EMB ? [[null, 'Profile'], ['billing', 'Plan and billing']] : [[null, 'Profile'], ['billing', 'Plan and billing'], ['password', 'Password']], tab);
    if (tab === 'billing') return billingPage(ctx, head);
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
        <div class="field"><label for="pe">Email</label><input id="pe" value="${esc(S.me.email)}" readonly><p class="hint">${S.license?.shopify ? 'Your account belongs to this Shopify store.' : 'To change your login email, write to hello@tharam.store.'}</p></div></div></div>
      <div class="form-section"><div><h3>Plan</h3><p class="explain">What your plan includes, when it renews, and your payments.</p></div>
        <div class="controls"><div><span class="pill ${S.license?.usable ? 'healthy' : 'critical'}">${esc(S.license?.plan.name || '')}</span></div><p style="margin:0"><a href="#/account/billing">Plan and billing</a></p></div></div></form>
      ${S.license?.shopify ? '<section class="settings-card" id="webacc"></section>' : ''}</div>`;
    if (S.license?.shopify) webAccessPanel($('#webacc'));
    const form = $('#prof');
    const mark = savebar($('.main-inner', ctx.main), {
      onSave: async () => { await api('/api/account', { method: 'PATCH', body: { name: new FormData(form).get('name') } }); S.me = (await api('/api/me')).user; },
      onDiscard: () => render(),
    });
    form.addEventListener('input', mark);
  };

  const STATE = { trial: ['Free trial', 'running'], active: ['Active', 'healthy'], grace: ['Payment due', 'warning'], expired: ['Expired', 'critical'], suspended: ['Paused', 'critical'], cancelled: ['Ended', 'critical'] };
  async function billingPage(ctx, head) {
    const d = await api('/api/account/billing');
    if (!ctx.alive()) return;
    S.catalog = S.catalog || (await api('/api/catalog'));
    const L = d.license;
    const [stLabel, stKey] = STATE[L.state] || [L.state, ''];
    const price = L.price ? `${minorMoney(L.price.amount, L.price.currency)} <span class="muted">per ${L.price.period === 'year' ? 'year' : 'month'}${L.price.custom ? '' : ` · ${minorMoney(L.price.perStore, L.price.currency)} per store`}</span>` : L.plan.kind === 'paid' ? '<span class="muted">Price agreed with you</span>' : '<span class="muted">Free</span>';
    const when = L.expires_at ? (L.state === 'grace' ? `Expired ${dateOnly(L.expires_at)} · checks continue until ${dateOnly(L.graceEnds)}` : L.state === 'expired' ? `Expired ${dateOnly(L.expires_at)}` : `${L.plan.kind === 'paid' ? 'Paid until' : 'Ends'} ${dateOnly(L.expires_at)}${L.daysLeft != null && L.daysLeft >= 0 ? ` · ${L.daysLeft} day${L.daysLeft === 1 ? '' : 's'} left` : ''}`) : 'No end date';
    const pct = Math.min(100, Math.round((L.storesUsed / Math.max(1, L.maxStores)) * 100));
    const feats = S.catalog.features.map((f) => `<li class="${L.features.includes(f.key) ? '' : 'off'}">${icon(L.features.includes(f.key) ? 'check' : 'lock', 15)}<span>${esc(f.label)}</span>${L.features.includes(f.key) ? '' : `<span class="muted">${esc(f.plans)}</span>`}</li>`).join('');
    const pays = d.payments.length ? `<div class="table-wrap flat"><table class="data"><thead><tr><th>Date</th><th class="num">Amount</th><th>For</th><th>Reference</th></tr></thead><tbody>
      ${d.payments.map((p) => `<tr><td>${esc(dateOnly(p.created_at))}</td><td class="num"><b>${minorMoney(p.amount, p.currency)}</b></td><td class="cell-sub">${p.periods} ${p.period}${p.periods > 1 ? 's' : ''} · until ${esc(dateOnly(p.covers_to))}</td><td class="cell-sub">${esc(p.reference || '–')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">No payments yet.</p>';
    ctx.main.innerHTML = `<div class="main-inner">${head}
      <div class="bill-grid">
        <section class="panel bill-plan"><div class="bp-top"><div><p class="kicker">Your plan</p><h2>${esc(L.plan.name)}</h2><p class="muted" style="margin:2px 0 0">${esc(L.plan.tagline || '')}</p></div><span class="pill ${stKey}">${esc(stLabel)}</span></div>
          <dl class="bill-facts"><div><dt>Price</dt><dd>${price}</dd></div><div><dt>Renewal</dt><dd>${esc(when)}</dd></div>
          <div><dt>Stores</dt><dd>${L.storesUsed} of ${L.maxStores} in use<div class="meter"><i style="width:${pct}%"></i></div></dd></div>
          <div><dt>Checks</dt><dd>Shopping checks as often as ${esc((EVERY[L.limits.journeyMinInterval] || '').toLowerCase())} · full check ${esc((FULL_EVERY[L.limits.fullMinInterval] || '').toLowerCase())}</dd></div></dl></section>
        ${S.license?.shopify ? `<section class="panel"><h2>Change your plan</h2><p class="sub">Your plan is billed through Shopify, on your Shopify invoice. You can upgrade, downgrade or cancel at any time.</p>
          <div class="inline-row" style="margin-top:12px"><a class="btn" href="${esc(S.license.shopify.pricingUrl)}" target="_top">${icon('arrow', 16)}Choose a plan</a></div></section>`
        : `<section class="panel"><h2>Pay, renew or change plan</h2><p class="sub">${L.plan.kind === 'paid' ? 'Renew, add stores, or move to another plan. Unused time on your current plan is added to the new one.' : 'Choose a plan and pay online. It starts straight away.'}</p>
          <div class="inline-row" style="margin-top:12px"><button type="button" class="btn" id="change-plan">${icon('arrow', 16)}${L.plan.kind === 'paid' ? 'Renew or change plan' : 'Choose a plan'}</button><a class="btn secondary" href="/pricing" target="_blank" rel="noopener">Compare plans</a></div>
          <p class="hint" style="margin-top:12px">${esc(L.note || '')}</p></section>`}
      </div>
      <section class="panel"><h2>What your plan includes</h2><ul class="feat-list">${feats}</ul></section>
      <section class="panel"><h2>Payments</h2>${pays}</section></div>`;
    $('#change-plan')?.addEventListener('click', () => planPicker(L));
  }

  // ---------- Choose and pay for a plan (website customers) ----------
  function loadScript(src) {
    return new Promise((res, rej) => { if ([...document.scripts].some((x) => x.src === src)) return res(); const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('Couldn’t load the payment window. Check your connection.')); document.head.appendChild(el); });
  }
  async function planPicker(L) {
    const pl = await api('/api/public/plans');
    const plans = pl.plans.filter((p) => p.kind === 'paid');
    const curs = [...new Set(plans.flatMap((p) => Object.keys(p.prices)))];
    const cur0 = curs.includes(L.currency) ? L.currency : curs.includes('INR') && Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Calcutta' ? 'INR' : curs[0];
    const sel = { plan_key: plans.find((p) => p.key === L.plan.key)?.key || plans.find((p) => p.highlight)?.key || plans[1]?.key || plans[0].key, seats: Math.max(1, L.storesUsed, L.plan.kind === 'paid' ? L.seats : 1), period: L.billing === 'year' ? 'year' : 'month', currency: cur0 };
    const body = `<div class="pp-plans">${plans.map((p) => `<label class="pp-plan"><input type="radio" name="plan" value="${p.key}" ${p.key === sel.plan_key ? 'checked' : ''}><span><b>${esc(p.name)}</b><small>${esc(p.tagline || '')}</small><em data-price="${p.key}"></em></span></label>`).join('')}</div>
      <div class="form-grid" style="margin-top:14px"><div class="field"><label for="pp-seats">Stores</label><input id="pp-seats" name="seats" type="number" min="1" max="1000" value="${sel.seats}"></div>
        <div class="field"><label>Billing</label><div class="seg" role="radiogroup">${[['month', 'Monthly'], ['year', 'Yearly · 2 months free']].map(([k, l]) => `<label><input type="radio" name="period" value="${k}" ${k === sel.period ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
        ${curs.length > 1 ? `<div class="field"><label for="pp-cur">Currency</label><select id="pp-cur" name="currency">${curs.map((c) => `<option ${c === sel.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>` : ''}</div>
      <div class="pp-quote" id="pp-quote"><span class="spinner"></span></div>`;
    let last = null, online = false;
    const ok = await formDialog({ title: L.plan.kind === 'paid' ? 'Renew or change your plan' : 'Choose your plan', body, submit: 'Continue to payment', wide: true,
      onOpen: (dl) => {
        const f = dl.querySelector('form');
        const read = () => ({ plan_key: f.plan.value, seats: Number(f.seats.value), period: f.period.value, currency: f.currency?.value || sel.currency });
        let t;
        const refresh = () => {
          const v = read();
          plans.forEach((p) => { const pr = p.prices[v.currency]?.[v.period]; dl.querySelector(`[data-price="${p.key}"]`).textContent = pr != null ? `${minorMoney(pr, v.currency)} per store / ${v.period === 'year' ? 'year' : 'month'}` : 'Not offered'; });
          clearTimeout(t);
          t = setTimeout(async () => {
            const box = dl.querySelector('#pp-quote');
            try {
              const r = await api('/api/account/quote', { method: 'POST', body: v });
              last = r.quote; online = r.online;
              const qd = r.quote;
              box.innerHTML = `<div class="pq-amount"><span>You pay now</span><b>${minorMoney(qd.amount, qd.currency)}</b></div>
                <p>${qd.kind === 'renew' ? `Renews ${esc(qd.plan.name)} for another ${qd.period}.` : `${esc(qd.plan.name)} for ${qd.seats} store${qd.seats === 1 ? '' : 's'}, starting today.`} Paid until <b>${esc(dateOnly(qd.to))}</b>.${qd.creditDays ? ` Includes ${qd.creditDays} extra days for the unused time on your current plan.` : ''}</p>
                ${online ? '' : '<p class="hint">Online payment isn’t switched on yet. Continue and we’ll email you an invoice for this.</p>'}`;
              f.querySelector('button[type=submit]').disabled = false;
            } catch (ex) { last = null; box.innerHTML = `<p class="error-msg">${esc(ex.message)}</p>`; f.querySelector('button[type=submit]').disabled = true; }
          }, 250);
        };
        f.addEventListener('input', refresh); f.addEventListener('change', refresh); refresh();
      },
      onSubmit: async () => {
        if (!last) throw new Error('Choose a plan first');
        if (!online) { location.href = `mailto:hello@tharam.store?subject=${encodeURIComponent(`Tharam ${last.plan.name}: ${S.me.email}`)}&body=${encodeURIComponent(`Please send me an invoice for ${last.plan.name}, ${last.seats} store(s), ${last.period === 'year' ? 'yearly' : 'monthly'}: ${minorMoney(last.amount, last.currency)}.`)}`; return 'mail'; }
        const co = await api('/api/account/checkout', { method: 'POST', body: { plan_key: last.plan.key, seats: last.seats, period: last.period, currency: last.currency } });
        await loadScript('https://checkout.razorpay.com/v1/checkout.js');
        return new Promise((resolve, reject) => {
          const rz = new window.Razorpay({ key: co.key, order_id: co.orderId, amount: co.amount, currency: co.currency, name: co.name, description: co.description, prefill: { email: co.email }, theme: { color: '#3346d3' },
            handler: async (resp) => { try { await api('/api/account/checkout/verify', { method: 'POST', body: resp }); resolve('paid'); } catch (ex) { reject(ex); } },
            modal: { ondismiss: () => reject(new Error('Payment was cancelled. Nothing was charged.')) } });
          rz.on('payment.failed', (r) => reject(new Error(r.error?.description || 'The payment didn’t go through. Nothing was charged.')));
          rz.open();
        });
      } });
    if (ok === 'paid') { toast('Payment received. Your plan is updated.'); await loadStores(); render({ silent: true }); }
  }

  async function adminLeads(ctx, head) {
    const d = await api('/api/admin/overview');
    if (!ctx.alive()) return;
    const t = (rows, cols, map = (r, c) => esc(r[c] ?? '')) => rows.length ? `<div class="table-wrap"><table class="data"><thead><tr>${cols.map((c) => `<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${map(r, c[0])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing yet.</p>';
    ctx.main.innerHTML = `<div class="main-inner">${head}
      <div class="figures" style="grid-template-columns:repeat(4,minmax(0,1fr))"><div class="figure"><b>${d.users}</b><span>accounts</span></div><div class="figure"><b>${d.stores}</b><span>stores added</span></div><div class="figure"><b>${d.freeScans24h}</b><span>free checks, 24 h</span></div><div class="figure"><b>${d.queue.active} / ${d.queue.waiting}</b><span>running / waiting</span></div></div>
      <section class="panel"><h2>Signups</h2>${t(d.signups, [['email', 'Email'], ['name', 'Name'], ['stores', 'Stores'], ['created_at', 'Joined']], (r, c) => (c === 'created_at' ? time(r[c]) : esc(r[c] ?? '')))}</section>
      <section class="panel"><h2>Leads</h2>${t(d.leads, [['email', 'Email'], ['store_url', 'Store'], ['source', 'Source'], ['created_at', 'When']], (r, c) => (c === 'created_at' ? time(r[c]) : esc(r[c] ?? '')))}</section>
      <section class="panel"><h2>Free checks</h2>${t(d.recentScans, [['url', 'Store'], ['score', 'Score'], ['verdict', 'Result'], ['created_at', 'When'], ['id', 'Report']], (r, c) => (c === 'created_at' ? time(r[c]) : c === 'id' ? `<a href="/scan/${r.id}" target="_blank" rel="noopener">Open</a>` : c === 'verdict' ? esc(VERDICT[r.verdict] || r.status) : esc(r[c] ?? '')))}</section></div>`;
  };

  // ---------- Founder console ----------
  const STATE_PILL = (st) => { const [l, k] = STATE[st] || [st, '']; return `<span class="pill ${k}">${esc(l)}</span>`; };
  const sumMoney = (obj) => Object.entries(obj || {}).map(([c, v]) => minorMoney(v, c)).join(' + ') || '0';
  const toMinor = (v) => (v === '' || v == null ? '' : Math.round(Number(v) * 100));
  const toMajor = (v) => (v == null || v === '' ? '' : (v / 100).toString());
  const METHODS = { bank: 'Bank transfer', upi: 'UPI', card: 'Card', razorpay: 'Razorpay', stripe: 'Stripe', shopify: 'Shopify billing', cash: 'Cash', other: 'Other' };
  const CURS = ['USD', 'EUR', 'INR', 'GBP', 'AUD', 'CAD', 'SGD', 'AED'];
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
  const ACTION = { 'license.create': 'Licence created', 'license.update': 'Licence changed', 'payment.record': 'Payment recorded', note: 'Note', 'plan.create': 'Plan created', 'plan.update': 'Plan changed', 'setting.change': 'Setting changed', 'store.sale': 'Sale mode' };
  function auditText(a) {
    const d = a.detail_json ? JSON.parse(a.detail_json) : {};
    if (a.action === 'note') return esc(d.text);
    if (a.action === 'payment.record') return `${minorMoney(d.amount, d.currency)} by ${esc(METHODS[d.method] || d.method)}${d.reference ? ` (${esc(d.reference)})` : ''} · ${d.periods} ${d.period}${d.periods > 1 ? 's' : ''} · expiry ${esc(d.expires_before || 'none')} → ${esc(d.expires_after)}`;
    if (a.action === 'license.update') return Object.entries(d).map(([k, v]) => `${esc(k.replace('_', ' '))}: ${esc(v.before ?? '–')} → <b>${esc(v.after ?? '–')}</b>`).join(' · ');
    if (a.action === 'license.create') return `${esc(d.plan)}, ${d.seats} store${d.seats === 1 ? '' : 's'}${d.expires_at ? `, until ${esc(d.expires_at)}` : ''}`;
    if (a.action === 'store.sale') return `${esc(d.store)}: ${d.after ? `on until ${esc(d.after)}` : 'off'}`;
    if (a.action === 'setting.change') return `${esc(d.key)}: ${esc(d.before)} → <b>${esc(d.after)}</b>`;
    if (a.action.startsWith('plan.')) return esc(d.key);
    return '';
  }
  const rowsLink = (root) => $$('tr.link', root).forEach((tr) => { tr.onclick = () => (location.hash = tr.dataset.href); tr.onkeydown = (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; }; });

  PAGES.admin = async (ctx) => {
    if (!S.admin) { location.hash = '#/'; return; }
    const tab = ctx.r.a;
    const head = `<div class="page-head"><div><div class="crumbs">Workspace</div><h1>Founder console</h1><div class="meta">Customers, plans and revenue · only visible to founders</div></div></div>`
      + tabs('#/admin', [[null, 'Overview'], ['customers', 'Customers'], ['plans', 'Plans'], ['payments', 'Payments'], ['audit', 'Audit log'], ['settings', 'Settings'], ['leads', 'Leads and free checks']], tab);
    if (tab === 'customers' && ctx.r.b) return adminCustomer(ctx, head, ctx.r.b);
    if (tab === 'customers') return adminCustomers(ctx, head);
    if (tab === 'plans') return adminPlans(ctx, head);
    if (tab === 'payments') return adminPayments(ctx, head);
    if (tab === 'audit') return adminAudit(ctx, head);
    if (tab === 'settings') return adminSettings(ctx, head);
    if (tab === 'leads') return adminLeads(ctx, head);
    const d = await api('/api/admin/billing');
    if (!ctx.alive()) return;
    const c = d.counts;
    const fig = (v, l, href) => `<a class="figure link-fig" href="${href}"><b>${v}</b><span>${esc(l)}</span></a>`;
    ctx.main.innerHTML = `<div class="main-inner">${head}
      <div class="figures" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        ${fig(sumMoney(d.mrr), 'Monthly recurring revenue', '#/admin/customers')}
        ${fig(d.rev30.length ? d.rev30.map((x) => minorMoney(x.amount, x.currency)).join(' + ') : '0', 'Received, last 30 days', '#/admin/payments')}
        ${fig(c.paying, 'Paying customers', '#/admin/customers')}
        ${fig(c.customers, 'Accounts', '#/admin/customers')}</div>
      <div class="figures" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        ${fig(c.trial, 'On free trial', '#/admin/customers?state=trial')}
        ${fig(c.grace, 'Payment due (grace)', '#/admin/customers?state=grace')}
        ${fig(c.expired, 'Expired', '#/admin/customers?state=expired')}
        ${fig(c.suspended + c.cancelled, 'Paused or ended', '#/admin/customers')}</div>
      <div class="grid-2 tight"><section class="panel"><h2>Ending in the next 14 days</h2>
        ${d.expiringSoon.length ? `<div class="table-wrap flat"><table class="data"><thead><tr><th>Customer</th><th>Plan</th><th>Ends</th></tr></thead><tbody>${d.expiringSoon.map((x) => `<tr class="link" data-href="#/admin/customers/${x.id}" tabindex="0"><td><span class="cell-main">${esc(x.email)}</span></td><td>${esc(x.plan)} ${STATE_PILL(x.state)}</td><td>${esc(dateOnly(x.expires_at))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">Nothing ends in the next two weeks.</p>'}</section>
      <section class="panel"><h2>Latest payments</h2>
        ${d.recentPayments.length ? `<div class="table-wrap flat"><table class="data"><thead><tr><th>Customer</th><th class="num">Amount</th><th>When</th></tr></thead><tbody>${d.recentPayments.map((p) => `<tr class="link" data-href="#/admin/customers/${p.user_id}" tabindex="0"><td>${esc(p.email)}</td><td class="num"><b>${minorMoney(p.amount, p.currency)}</b></td><td>${time(p.created_at)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">No payments recorded yet.</p>'}</section></div>
      <section class="panel"><h2>Customers by plan</h2><div class="chips-row">${Object.entries(d.plans).map(([k, n]) => `<span class="chip">${esc(k)} · ${n}</span>`).join('')}</div></section></div>`;
    rowsLink(ctx.main);
  };

  async function adminCustomers(ctx, head) {
    const qs = new URLSearchParams(location.hash.split('?')[1] || '');
    const d = await api(`/api/admin/customers?${qs}`);
    if (!ctx.alive()) return;
    const st = qs.get('state') || '';
    const filters = [['', 'All'], ['trial', 'Trial'], ['active', 'Active'], ['grace', 'Payment due'], ['expired', 'Expired'], ['suspended', 'Paused'], ['cancelled', 'Ended']];
    ctx.main.innerHTML = `<div class="main-inner">${head}
      <div class="toolbar"><input id="cq" type="search" placeholder="Search by email or name" value="${esc(qs.get('q') || '')}" style="max-width:320px">
        <div class="seg">${filters.map(([k, l]) => `<label><input type="radio" name="st" value="${k}" ${k === st ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th class="num">Stores</th><th>Ends</th><th class="num">MRR</th><th>Last test</th><th aria-label="Open"></th></tr></thead><tbody>
      ${d.customers.map((x) => `<tr class="link" data-href="#/admin/customers/${x.id}" tabindex="0"><td><span class="cell-main">${esc(x.email)}</span><div class="cell-sub">${esc(x.name || '')} · joined ${esc(dateOnly(x.created_at))}</div></td>
        <td>${esc(x.plan)}<div class="cell-sub">${x.price ? `${minorMoney(x.price.amount, x.price.currency)} / ${x.price.period}` : x.plan_kind === 'paid' ? 'No price set' : 'Free'}</div></td><td>${STATE_PILL(x.state)}</td>
        <td class="num">${x.stores} / ${x.seats}</td><td>${x.expires_at ? esc(dateOnly(x.expires_at)) : '<span class="muted">No end</span>'}</td><td class="num">${x.mrr ? minorMoney(x.mrr, x.currency) : '–'}</td>
        <td class="cell-sub">${x.last_run ? time(x.last_run) : 'Never'}</td><td class="go">${icon('right', 16)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No customers match.</td></tr>'}</tbody></table></div></div>`;
    rowsLink(ctx.main);
    const go = () => { const p = new URLSearchParams(); const q = $('#cq').value.trim(); const v = $('input[name=st]:checked')?.value; if (q) p.set('q', q); if (v) p.set('state', v); location.hash = `#/admin/customers${p.toString() ? '?' + p : ''}`; };
    $$('input[name=st]', ctx.main).forEach((i) => (i.onchange = go));
    $('#cq').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  async function adminCustomer(ctx, head, uid) {
    const [d, pl] = await Promise.all([api(`/api/admin/customers/${uid}`), api('/api/admin/plans')]);
    if (!ctx.alive()) return;
    const L = d.license;
    const v = d.view;
    const exp = L.expires_at ? L.expires_at.slice(0, 10) : '';
    ctx.main.innerHTML = `<div class="main-inner">${head}
      <div class="page-head" style="margin-top:4px"><div><div class="crumbs"><a href="#/admin/customers">Customers</a></div><h1 style="font-size:20px">${esc(d.user.email)}</h1><div class="meta">${esc(d.user.name || '')} · joined ${esc(dateOnly(d.user.created_at))} · ${STATE_PILL(L.state)}</div></div>
        <div class="actions"><button class="btn" id="pay">${icon('add', 16)}Record payment</button>
          ${L.state === 'suspended' ? '<button class="btn secondary" id="resume">Turn back on</button>' : '<button class="btn secondary" id="pause">Pause account</button>'}</div></div>
      <div class="figures" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="figure"><b>${esc(v.plan.name)}</b><span>Plan</span></div>
        <div class="figure"><b>${L.price ? minorMoney(L.price.amount, L.price.currency) : v.plan.kind === 'paid' ? 'No price' : 'Free'}</b><span>${L.price ? `per ${L.price.period}${L.price.custom ? ' (custom)' : ''}` : 'Price'}</span></div>
        <div class="figure"><b>${v.storesUsed} / ${v.maxStores}</b><span>Stores in use</span></div>
        <div class="figure"><b>${L.expires_at ? esc(dateOnly(L.expires_at)) : 'No end'}</b><span>${L.state === 'grace' ? `Grace until ${esc(dateOnly(v.graceEnds))}` : 'Paid until / ends'}</span></div></div>
      <form class="settings-card" id="licf"><div class="form-section"><div><h3>Licence</h3><p class="explain">What this customer gets. Every change is saved to the audit log with your name.</p></div>
        <div class="controls"><div class="form-grid">
          <div class="field"><label>Plan</label><select name="plan_key">${pl.plans.map((p) => opt(p.key, `${p.name}${p.active ? '' : ' (retired)'}`, L.plan_key)).join('')}</select></div>
          <div class="field"><label>Stores (seats)</label><input name="seats" type="number" min="1" max="1000" value="${L.seats}"></div>
          <div class="field"><label>Status</label><select name="status">${[['trial', 'Free trial'], ['active', 'Active'], ['suspended', 'Paused'], ['cancelled', 'Ended']].map(([k, l]) => opt(k, l, L.status)).join('')}</select></div>
          <div class="field"><label>Paid until / ends</label><input name="expires_at" type="date" value="${esc(exp)}"><p class="hint">Empty means no end date.</p></div>
          <div class="field"><label>Billing</label><select name="billing">${[['month', 'Monthly'], ['year', 'Yearly'], ['custom', 'Custom']].map(([k, l]) => opt(k, l, L.billing)).join('')}</select></div>
          <div class="field"><label>Currency</label><select name="currency">${CURS.map((c) => opt(c, c, L.currency)).join('')}</select></div>
          <div class="field"><label>Custom price per period</label><input name="price_override" type="number" min="0" step="0.01" value="${esc(toMajor(L.price_override))}" placeholder="Plan price × stores"><p class="hint">For the whole licence. Empty uses the plan price.</p></div>
          <div class="field"><label>Grace days</label><input name="grace_days" type="number" min="0" max="90" value="${L.grace_days ?? ''}" placeholder="Default"></div></div>
          <div class="field"><label>Private notes</label><textarea name="notes" rows="2">${esc(L.notes || '')}</textarea></div>
          <p class="error-msg" id="lic-err" role="alert"></p><div><button class="btn" type="submit">Save licence</button></div></div></div></form>
      <section class="panel"><h2>Stores</h2>${d.stores.length ? `<div class="table-wrap flat"><table class="data"><thead><tr><th>Store</th><th>Status</th><th>Last test</th><th>Plan</th><th>Sale mode</th></tr></thead><tbody>${d.stores.map((x) => `<tr><td><span class="cell-main">${esc(x.name || host(x.url))}</span><div class="cell-sub">${esc(x.url)}${x.platform ? ` · ${esc(x.platform)}` : ''}</div></td><td>${esc(VERDICT[x.last_status] || 'Not tested')}${x.monitoring ? '' : ' · paused'}</td><td>${x.last_run_at ? time(x.last_run_at) : '–'}</td><td class="cell-sub">${x.blocked ? `<span class="t-fail">${esc(x.blocked)}</span>` : 'Covered'}</td>
        <td>${x.saleUntil ? `<span class="pill running">Until ${esc(dateOnly(x.saleUntil + ' 23:59:59'))}</span> ` : ''}<button type="button" class="btn small secondary" data-sale="${x.id}" data-until="${esc(x.saleUntil || '')}">${x.saleUntil ? 'Change' : 'Turn on'}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">No stores yet.</p>'}</section>
      <section class="panel"><h2>Payments</h2>${d.payments.length ? `<div class="table-wrap flat"><table class="data"><thead><tr><th>Recorded</th><th class="num">Amount</th><th>Method</th><th>Covers</th><th>By</th></tr></thead><tbody>${d.payments.map((p) => `<tr><td>${esc(dateOnly(p.created_at))}</td><td class="num"><b>${minorMoney(p.amount, p.currency)}</b></td><td>${esc(METHODS[p.method] || p.method)}${p.reference ? `<div class="cell-sub">${esc(p.reference)}</div>` : ''}</td><td class="cell-sub">${esc(dateOnly(p.covers_from))} → ${esc(dateOnly(p.covers_to))}</td><td class="cell-sub">${esc(p.recorded_by)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">No payments yet.</p>'}</section>
      <section class="panel"><div class="panel-head"><h2>History</h2><button class="btn small secondary" id="note">Add note</button></div>
        <ul class="list">${d.audit.map((a) => `<li><div class="row"><span class="sev ${a.action === 'payment.record' ? 'ok' : a.action === 'note' ? '' : 'warn'}">${esc(ACTION[a.action] || a.action)}</span><span><span class="d">${auditText(a)}</span><span class="d muted">${esc(a.actor)}</span></span><span class="r">${time(a.created_at)}</span></div></li>`).join('')}</ul></section></div>`;
    $('#licf').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, b = Object.fromEntries(new FormData(f));
      b.seats = Number(b.seats);
      b.price_override = b.price_override === '' ? null : toMinor(b.price_override);
      b.grace_days = b.grace_days === '' ? null : Number(b.grace_days);
      // Only send the date if it was changed, so saving notes never moves an exact expiry time.
      if ((b.expires_at || '') === exp) delete b.expires_at; else b.expires_at = b.expires_at || null;
      const done = busy(f.querySelector('button[type=submit]'), 'Saving');
      try { await api(`/api/admin/customers/${uid}/license`, { method: 'PATCH', body: b }); toast('Licence saved'); render({ silent: true }); } catch (ex) { done(); $('#lic-err').textContent = ex.message; }
    };
    const setStatus = async (status, title, body, confirm) => {
      if (!(await confirmDialog({ title, body, confirm, danger: status === 'suspended' }))) return;
      try { await api(`/api/admin/customers/${uid}/license`, { method: 'PATCH', body: { status } }); toast('Saved'); render({ silent: true }); } catch (ex) { toast(ex.message, 'error'); }
    };
    $('#pause')?.addEventListener('click', () => setStatus('suspended', `Pause ${d.user.email}?`, 'Their checks and alerts stop at once. They can still log in and see reports.', 'Pause account'));
    $('#resume')?.addEventListener('click', () => setStatus('active', 'Turn this account back on?', L.expires_at && new Date(L.expires_at.replace(' ', 'T') + 'Z') < Date.now() ? 'Their paid-until date has passed, so they will still show as expired. Record a payment or set a new date too.' : 'Checks and alerts start again.', 'Turn back on'));
    $$('[data-sale]', ctx.main).forEach((b) => (b.onclick = async () => {
      const cur = b.dataset.until;
      const ok = await formDialog({ title: 'Sale mode', wide: false, submit: 'Save',
        body: `<p>Shopping checks every 30 minutes and a full check every 6 hours, whatever the plan, until the end of the chosen day. Up to 31 days.</p>
          <div class="field"><label for="su">Until</label><input id="su" name="until" type="date" value="${esc(cur)}" min="${new Date().toISOString().slice(0, 10)}"></div>
          ${cur ? '<label class="check-line"><input type="checkbox" name="off"><span>Turn sale mode off now</span></label>' : ''}`,
        onSubmit: (f) => api(`/api/admin/stores/${b.dataset.sale}/sale`, { method: 'POST', body: { until: f.off?.checked ? null : f.until.value || null } }) });
      if (ok) { toast(ok.saleUntil ? `Sale mode on until ${dateOnly(ok.saleUntil + ' 23:59:59')}` : 'Sale mode off'); render({ silent: true }); }
    }));
    $('#note').onclick = async () => {
      if (await formDialog({ title: 'Add a note', body: '<div class="field"><label for="nt">Note</label><textarea id="nt" name="text" rows="4" maxlength="1000" required></textarea></div>', submit: 'Add note', onSubmit: (f) => api(`/api/admin/customers/${uid}/note`, { method: 'POST', body: { text: f.text.value } }) })) render({ silent: true });
    };
    $('#pay').onclick = async () => {
      const plan = pl.plans.find((p) => p.key === L.plan_key);
      const cur = L.currency, per = L.billing === 'year' ? 'year' : 'month';
      const suggested = L.price?.amount ?? (plan?.prices?.[cur]?.[per] != null ? plan.prices[cur][per] * L.seats : '');
      const body = `<p>Records money received and extends the licence. ${L.state === 'grace' ? 'The payment is late, so the new period continues from the old end date.' : L.state === 'expired' || L.state === 'suspended' ? 'This also turns the account back on.' : ''}</p>
        <div class="form-grid"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="0.01" value="${esc(toMajor(suggested))}" required></div>
        <div class="field"><label>Currency</label><select name="currency">${CURS.map((c) => opt(c, c, cur)).join('')}</select></div>
        <div class="field"><label>Paid for</label><input name="periods" type="number" min="1" max="36" value="1"></div>
        <div class="field"><label>Period</label><select name="period">${opt('month', 'Months', per)}${opt('year', 'Years', per)}</select></div>
        <div class="field"><label>Method</label><select name="method">${Object.entries(METHODS).map(([k, l]) => opt(k, l, 'upi')).join('')}</select></div>
        <div class="field"><label>Reference</label><input name="reference" placeholder="UTR, transaction or invoice number"></div>
        <div class="field"><label>Plan paid for</label><select name="plan_key">${pl.plans.filter((p) => p.kind === 'paid').map((p) => opt(p.key, p.name, plan?.kind === 'paid' ? L.plan_key : '')).join('')}</select></div>
        <div class="field"><label>Stores paid for</label><input name="seats" type="number" min="1" max="1000" value="${plan?.kind === 'paid' ? L.seats : ''}" placeholder="e.g. 1" required></div></div>
        <div class="field"><label>Note</label><input name="note" maxlength="500"></div>
        <label class="check-line"><input type="checkbox" name="sendReceipt" checked><span>Email a receipt to ${esc(d.user.email)}</span></label>
        <label class="check-line"><input type="checkbox" name="confirmDuplicate"><span>This is a second payment of the same amount (not a repeat entry)</span></label>`;
      const ok = await formDialog({ title: 'Record payment', body, submit: 'Record payment', wide: true, onSubmit: (f) => api(`/api/admin/customers/${uid}/payments`, { method: 'POST', body: {
        amount: f.amount.value === '' ? '' : toMinor(f.amount.value), currency: f.currency.value, periods: Number(f.periods.value), period: f.period.value, method: f.method.value, reference: f.reference.value, plan_key: f.plan_key.value, seats: f.seats.value === '' ? '' : Number(f.seats.value), note: f.note.value, sendReceipt: f.sendReceipt.checked, confirmDuplicate: f.confirmDuplicate.checked } }) });
      if (ok) { toast(`Payment recorded. Active until ${dateOnly(ok.view.expires_at)}`); render({ silent: true }); }
    };
  }

  async function adminPlans(ctx, head) {
    const d = await api('/api/admin/plans');
    if (!ctx.alive()) return;
    ctx.main.innerHTML = `<div class="main-inner">${head}
      <div class="toolbar"><p class="muted" style="margin:0">Plans decide what each store gets. Prices are per store. Public plans appear on the pricing page, in this order.</p><button class="btn" id="newp">${icon('add', 16)}New plan</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Plan</th><th>Price per store</th><th>Includes</th><th>Limits</th><th class="num">Customers</th><th>Shown</th><th aria-label="Edit"></th></tr></thead><tbody>
      ${d.plans.map((p) => `<tr><td><span class="cell-main">${esc(p.name)}</span><div class="cell-sub">${esc(p.key)} · ${esc(p.kind)}</div></td>
        <td class="cell-sub">${p.kind === 'paid' ? Object.entries(p.prices).map(([c, v]) => `${v.month != null ? minorMoney(v.month, c) + '/mo' : ''}${v.year != null ? ` · ${minorMoney(v.year, c)}/yr` : ''}`).join('<br>') : 'Free'}</td>
        <td class="cell-sub">${p.features.length} of ${d.features.length} features</td>
        <td class="cell-sub">${esc(EVERY[p.limits.journeyMinInterval] || '')} · ${p.limits.maxStores ? `max ${p.limits.maxStores} stores` : 'any stores'} · ${p.limits.environments} env.</td>
        <td class="num">${p.customers}</td><td>${!p.active ? '<span class="pill">Retired</span>' : p.public ? '<span class="pill healthy">Public</span>' : '<span class="pill">Hidden</span>'}</td>
        <td><button class="icon-btn" data-edit="${esc(p.key)}" aria-label="Edit ${esc(p.name)}" data-tip="Edit">${icon('edit', 17)}</button></td></tr>`).join('')}</tbody></table></div></div>`;
    const edit = async (p) => {
      const isNew = !p;
      p = p || { key: '', name: '', tagline: '', kind: 'paid', prices: {}, features: ['journeys'], limits: { journeyMinInterval: 60, fullMinInterval: 1440, environments: 0, maxStores: null }, public: false, highlight: false, active: true, sort: 10 };
      const priceRows = ['USD', 'EUR', 'INR', 'GBP'].map((c) => `<tr><td>${c}</td><td><input name="pm_${c}" type="number" min="0" step="0.01" value="${esc(toMajor(p.prices[c]?.month))}"></td><td><input name="py_${c}" type="number" min="0" step="0.01" value="${esc(toMajor(p.prices[c]?.year))}"></td></tr>`).join('');
      const body = `<div class="form-grid">
          ${isNew ? '<div class="field"><label>Key</label><input name="key" placeholder="e.g. agency" pattern="[a-z][a-z0-9-]{1,30}" required><p class="hint">Can’t be changed later.</p></div>' : ''}
          <div class="field"><label>Name</label><input name="name" value="${esc(p.name)}" required maxlength="40"></div>
          <div class="field"><label>Kind</label><select name="kind">${[['paid', 'Paid'], ['free', 'Free'], ['trial', 'Trial']].map(([k, l]) => opt(k, l, p.kind)).join('')}</select></div>
          <div class="field"><label>Order on pricing page</label><input name="sort" type="number" min="0" max="999" value="${p.sort}"></div></div>
        <div class="field"><label>One-line description</label><input name="tagline" value="${esc(p.tagline || '')}" maxlength="120"></div>
        <div class="field"><label>Price per store</label><table class="mini"><thead><tr><th></th><th>Monthly</th><th>Yearly</th></tr></thead><tbody>${priceRows}</tbody></table><p class="hint">Leave a currency empty to not offer it.</p></div>
        <fieldset class="field"><legend>Includes</legend><div class="feat-checks">${d.features.map((f) => `<label class="check-line"><input type="checkbox" name="f" value="${f.key}" ${p.features.includes(f.key) || f.always ? 'checked' : ''} ${f.always ? 'disabled' : ''}><span>${esc(f.label)}</span></label>`).join('')}</div></fieldset>
        <div class="form-grid">
          <div class="field"><label>Shopping checks, at most</label><select name="journeyMinInterval">${Object.entries(EVERY).map(([k, l]) => opt(k, l, p.limits.journeyMinInterval)).join('')}</select></div>
          <div class="field"><label>Full check, at most</label><select name="fullMinInterval">${Object.entries(FULL_EVERY).map(([k, l]) => opt(k, l, p.limits.fullMinInterval)).join('')}</select></div>
          <div class="field"><label>Environments per store</label><input name="environments" type="number" min="0" max="50" value="${p.limits.environments ?? 0}"></div>
          <div class="field"><label>Max stores</label><input name="maxStores" type="number" min="1" max="1000" value="${p.limits.maxStores ?? ''}" placeholder="No limit"></div>
          <div class="field"><label>Tests a customer can start, per store per day</label><input name="manualRunsPerDay" type="number" min="1" max="500" value="${p.limits.manualRunsPerDay ?? 20}"></div></div>
        <label class="check-line"><input type="checkbox" name="public" ${p.public ? 'checked' : ''}><span>Show on the pricing page</span></label>
        <label class="check-line"><input type="checkbox" name="highlight" ${p.highlight ? 'checked' : ''}><span>Highlight it</span></label>
        <label class="check-line"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}><span>Available (untick to retire; existing customers keep it)</span></label>
        ${!isNew && p.customers ? `<p class="hint">${p.customers} customer${p.customers === 1 ? ' is' : 's are'} on this plan. Changes apply to them straight away.</p>` : ''}`;
      const saved = await formDialog({ title: isNew ? 'New plan' : `Edit ${p.name}`, body, submit: 'Save plan', wide: true, onSubmit: (f) => {
        const prices = {};
        for (const c of ['USD', 'EUR', 'INR', 'GBP']) { const m = f[`pm_${c}`].value, y = f[`py_${c}`].value; if (m !== '' || y !== '') prices[c] = { month: m === '' ? null : toMinor(m), year: y === '' ? null : toMinor(y) }; }
        const b = { name: f.name.value, tagline: f.tagline.value, kind: f.kind.value, sort: Number(f.sort.value), prices, features: $$('input[name=f]:checked', f).map((x) => x.value),
          limits: { journeyMinInterval: Number(f.journeyMinInterval.value), fullMinInterval: Number(f.fullMinInterval.value), environments: Number(f.environments.value || 0), maxStores: f.maxStores.value === '' ? null : Number(f.maxStores.value), manualRunsPerDay: Number(f.manualRunsPerDay.value || 20) },
          public: f.public.checked, highlight: f.highlight.checked, active: f.active.checked };
        return isNew ? api('/api/admin/plans', { method: 'POST', body: { ...b, key: f.key.value.trim() } }) : api(`/api/admin/plans/${p.key}`, { method: 'PATCH', body: b });
      } });
      if (saved) { toast('Plan saved'); S.catalog = null; render({ silent: true }); }
    };
    $('#newp').onclick = () => edit(null);
    $$('[data-edit]', ctx.main).forEach((b) => (b.onclick = () => edit(d.plans.find((p) => p.key === b.dataset.edit))));
  }

  async function adminPayments(ctx, head) {
    const d = await api('/api/admin/payments');
    if (!ctx.alive()) return;
    ctx.main.innerHTML = `<div class="main-inner">${head}<div class="table-wrap"><table class="data"><thead><tr><th>Recorded</th><th>Customer</th><th class="num">Amount</th><th>Method</th><th>Covers</th><th>By</th></tr></thead><tbody>
      ${d.payments.map((p) => `<tr class="link" data-href="#/admin/customers/${p.user_id}" tabindex="0"><td>${esc(dateOnly(p.created_at))}</td><td>${esc(p.email)}</td><td class="num"><b>${minorMoney(p.amount, p.currency)}</b></td><td>${esc(METHODS[p.method] || p.method)}${p.reference ? `<div class="cell-sub">${esc(p.reference)}</div>` : ''}</td><td class="cell-sub">${esc(dateOnly(p.covers_from))} → ${esc(dateOnly(p.covers_to))}</td><td class="cell-sub">${esc(p.recorded_by)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>'}</tbody></table></div></div>`;
    rowsLink(ctx.main);
  }

  async function adminAudit(ctx, head) {
    const d = await api('/api/admin/audit');
    if (!ctx.alive()) return;
    ctx.main.innerHTML = `<div class="main-inner">${head}<p class="muted">Every change to licences, payments, plans and settings. This log can’t be edited or deleted.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>What</th><th>Customer</th><th>Details</th><th>By</th></tr></thead><tbody>
      ${d.audit.map((a) => `<tr ${a.user_id ? `class="link" data-href="#/admin/customers/${a.user_id}" tabindex="0"` : ''}><td class="nowrap">${esc(exact(a.created_at))}</td><td>${esc(ACTION[a.action] || a.action)}</td><td>${esc(a.email || '–')}</td><td class="cell-sub">${auditText(a)}</td><td class="cell-sub">${esc(a.actor)}</td></tr>`).join('')}</tbody></table></div></div>`;
    rowsLink(ctx.main);
  }

  async function adminSettings(ctx, head) {
    const d = await api('/api/admin/settings');
    if (!ctx.alive()) return;
    const st = d.settings;
    ctx.main.innerHTML = `<div class="main-inner">${head}<form class="settings-card" id="setf">
      <div class="form-section"><div><h3>New accounts</h3><p class="explain">The plan every new signup starts on. Choose the trial plan when the beta ends.</p></div>
        <div class="controls"><div class="field"><label>Plan for new signups</label><select name="signup_plan">${d.plans.map((p) => opt(p.key, `${p.name} (${p.kind})`, st.signup_plan)).join('')}</select></div>
        <div class="field"><label>Trial length, days</label><input name="trial_days" type="number" min="1" max="90" value="${esc(st.trial_days)}"></div></div></div>
      <div class="form-section"><div><h3>Late payments</h3><p class="explain">How long checks keep running after a paid plan’s end date, so a late payment never stops a store.</p></div>
        <div class="controls"><div class="field"><label>Grace days</label><input name="grace_days" type="number" min="0" max="90" value="${esc(st.grace_days)}"></div></div></div>
      <div class="form-section"><div><h3>How customers pay</h3><p class="explain">Shown on every customer’s Plan and billing page and in reminder emails.</p></div>
        <div class="controls"><div class="field"><label>Payment instructions</label><textarea name="payment_note" rows="4" maxlength="2000">${esc(st.payment_note)}</textarea></div></div></div>
      <div class="form-section"><div></div><div class="controls"><p class="error-msg" id="set-err" role="alert"></p><div><button class="btn" type="submit">Save settings</button></div></div></div></form></div>`;
    $('#setf').onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.trial_days = Number(b.trial_days); b.grace_days = Number(b.grace_days);
      const done = busy(e.target.querySelector('button[type=submit]'), 'Saving');
      try { await api('/api/admin/settings', { method: 'PATCH', body: b }); toast('Settings saved'); done(); } catch (ex) { done(); $('#set-err').textContent = ex.message; }
    };
  }

  // ---------- Add a store (setup) ----------
  PAGES.add = async (ctx) => {
    if (storesFull() && !S.wizard?.found) {
      ctx.main.innerHTML = `<div class="main-inner"><div class="page-head"><div><div class="crumbs">Workspace</div><h1>Add a store</h1></div></div>${upsell('journeys', S.license.usable ? `All ${S.license.maxStores} store${S.license.maxStores === 1 ? '' : 's'} on your plan are in use` : 'Your plan is not active', S.license.usable ? 'Add a store to your plan, or remove a store you no longer need, to add another.' : 'Renew your plan to add stores and start checks again.').replace(/<p class="muted"[^]*?<\/p>/, '')}</div>`;
      return;
    }
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
          // A first guess at where they sell, from the store's domain. The owner confirms it on the next step.
          const tld = host(d.origin).split('.').pop();
          w.markets = w.markets || ({ de: ['DE'], at: ['AT'], uk: ['UK'], in: ['IN'], sg: ['SG'], au: ['AU'], ca: ['CA'], ae: ['AE'], us: ['US'], fr: ['EU'], es: ['EU'], it: ['EU'], nl: ['EU'], be: ['EU'], ie: ['EU'] }[tld] || []);
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
        <div class="field" style="margin-bottom:24px"><label>Where do you sell?</label><div class="market-chips">${S.catalog.markets.map((m) => `<label class="mchip"><input type="checkbox" name="market" value="${m.code}" ${(w.markets || []).includes(m.code) ? 'checked' : ''}><span>${esc(m.label)}</span></label>`).join('')}</div>
          <p class="hint">We add checks for the laws in these countries. You can change this later in Store settings.</p></div>
        <div id="w-suite">${suiteRows(S.catalog.groups, w.disabled, { shopify, aiEnabled: S.catalog.aiEnabled, markets: w.markets || [] })}</div>
        <div class="wiz-actions"><button class="btn secondary" type="button" id="back">Back</button><div class="right"><button class="btn" type="submit">Continue</button></div></div></form>`);
      const form = $('#w2');
      form.addEventListener('change', (e) => e.target.name === 'g' && e.target.closest('.check-row')?.classList.toggle('off', !e.target.checked));
      $$('input[name=market]', form).forEach((i) => (i.onchange = () => {
        w.disabled = readDisabled($('#w-suite'));
        w.markets = $$('input[name=market]:checked', form).map((x) => x.value);
        $('#w-suite').innerHTML = suiteRows(S.catalog.groups, w.disabled, { shopify, aiEnabled: S.catalog.aiEnabled, markets: w.markets });
      }));
      const save = () => { w.markets = $$('input[name=market]:checked', form).map((x) => x.value); w.disabled = readDisabled(form).concat(shopify ? [] : S.catalog.groups.filter((g) => g.key.startsWith('journey.') && !g.locked).map((g) => g.key)); w.testProduct = $('#wtp')?.value || ''; };
      $('#back').onclick = () => { save(); w.step = 1; wizardStep(ctx); };
      form.onsubmit = (e) => { e.preventDefault(); save(); w.step = 3; wizardStep(ctx); };
      return;
    }

    if (w.step === 3) {
      const radios = (name, map, val) => `<div class="seg" role="radiogroup">${Object.entries(map).map(([k, l]) => `<label ${belowPlan(name, k) ? `title="Not included in your plan" class="na"` : ''}><input type="radio" name="${name}" value="${k}" ${Number(k) === val ? 'checked' : ''} ${belowPlan(name, k) ? 'disabled' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
      wrap(`<form class="settings-card" id="w3" novalidate>
        <div class="form-section"><div><h3>Journey tests</h3><p class="explain">How often we shop your store. If a test fails, we re-test every 30 minutes until it's fixed.</p></div><div class="controls">${radios('journeyIntervalMin', EVERY, w.journeyIntervalMin)}</div></div>
        <div class="form-section"><div><h3>Full check</h3><p class="explain">The journey plus speed, SEO, accessibility, links, catalog and visual changes.</p></div><div class="controls">${radios('fullIntervalMin', FULL_EVERY, w.fullIntervalMin)}</div></div>
        <div class="form-section"><div><h3>Alerts</h3><p class="explain">We alert once when something breaks and once when it recovers.</p></div>
          <div class="controls"><div class="field"><label for="wae">Email</label><input id="wae" name="alertEmail" type="email" value="${esc(w.alertEmail)}" required></div>
          ${can('slack') ? `<div class="field"><label for="wsl">Slack webhook URL <span class="muted" style="font-weight:400">(optional)</span></label><input id="wsl" name="slack" value="${esc(w.slack)}" placeholder="https://hooks.slack.com/services/…"><p class="hint">You can add this later under Alerts.</p></div>` : '<input type="hidden" name="slack" value="">'}</div></div>
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
        const r = await api('/api/stores', { method: 'POST', body: { url: w.url, name: host(w.url), password: w.password || undefined, alertEmail: w.alertEmail, slack: w.slack || undefined, monitoring: w.monitoring, runNow, platform: f.platform?.label, config: { toured: false, disabled: w.disabled, markets: w.markets || [], testProduct: w.testProduct || null, journeyIntervalMin: w.journeyIntervalMin, fullIntervalMin: w.fullIntervalMin } } });
        S.wizard = null;
        toast(runNow ? 'Store added. First check started.' : 'Store added');
        location.hash = `#/s/${r.id}`;
      } catch (ex) { done(); $('#w-err').textContent = ex.message; }
    };
    $('#save-run').onclick = (e) => submit(true, e.currentTarget);
    $('#save-only').onclick = (e) => submit(false, e.currentTarget);
  }

  // ---------- Boot ----------
  async function bootEmbedded() {
    document.body.classList.add('embedded');
    $('body').insertAdjacentHTML('beforeend', '<div class="emb-loading" id="emb-loading"><span class="spinner"></span><p>Connecting to your store…</p></div>');
    try {
      const sec = location.pathname.replace(/^\/shopify\/?/, '').split('/')[0] || 'overview';
      const sess = await api('/shopify/api/session', { method: 'POST', body: { welcome: sec === 'welcome' } });
      const me = await api('/api/me'); S.me = me.user; S.admin = false;
      S.shop = sess;
      if (!location.hash || location.hash === '#/' || location.hash === '#') {
        const map = { overview: '', welcome: '', reports: '/reports', publish: '/publish', catalog: '/catalog', alerts: '/alerts', suite: '/suite', tests: '/tests', settings: '/settings' };
        location.replace(sec === 'plan' ? '#/account/billing' : sec === 'account' ? '#/account' : sec === 'guide' ? '#/guide' : `#/s/${sess.storeId}${map[sec] ?? ''}`);
      }
    } catch (e) {
      $('#emb-loading').innerHTML = `<p><b>We couldn’t open Tharam.</b></p><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button>`;
      return;
    }
    $('#emb-loading')?.remove();
    shell();
    render();
  }
  // A sign-in link opened in a tab that already shows Tharam: start over so it is used.
  window.addEventListener('hashchange', () => { if (!EMB && /^#\/signin\//.test(location.hash)) location.reload(); });
  async function boot() {
    if (EMB) return bootEmbedded();
    const link = /^#\/signin\/([\w-]{40,60})$/.exec(location.hash);
    if (link) {
      history.replaceState(null, '', '/app#/');
      try {
        const r = await api('/api/auth/link/verify', { method: 'POST', body: { token: link[1] } });
        if (r.confirmed) S.flash = 'Your email is confirmed. You can now sign in to Tharam in any browser.';
      } catch (ex) { return authView('link', ex.message); }
    }
    try { const r = await api('/api/me'); S.me = r.user; S.admin = r.admin; }
    catch { return authView(location.hash === '#signup' ? 'signup' : 'login'); }
    shell();
    if (location.hash === '#signup') location.replace('#/');
    render();
    if (S.flash) { toast(S.flash); S.flash = null; }
  }
  boot();
})();
