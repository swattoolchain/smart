import { PRODUCTS, PLATFORMS, MARKETPLACES, STATUS } from './content.js';

export const VERSION = Date.now().toString(36);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const P = {
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  publish: '<path d="M12 20V9"/><path d="m7.5 13.5 4.5-4.5 4.5 4.5"/><path d="M5 4.5h14"/>',
  catalog: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><path d="M4 15h16M4 19h16"/>',
  speed: '<path d="M4 15a8 8 0 1 1 16 0"/><path d="m12 15 4-4"/>',
  sparkle: '<path d="M12 3.5 13.8 9 19.5 11l-5.7 2-1.8 5.5-1.8-5.5L4.5 11l5.7-2z"/>',
  reports: '<path d="M7 3.5h7l4.5 4.5V20a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M9.5 17v-3M12.5 17v-5M15.5 17v-2"/>',
  store: '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5h16v2a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 14.5a3 3 0 0 1-2.7-1.6A3 3 0 0 1 4 11.5z"/><path d="M5.5 14v6h13v-6"/>',
  market: '<circle cx="9" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/><path d="M3 4h2.5l2.2 11h10.6l2-8H7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  right: '<path d="m10 7 5 5-5 5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.4 3 7.8 7 9 4-1.2 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  tool: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5L4 16.7 7.3 20l5.2-5.2a4 4 0 0 0 5-5.3l-2.4 2.4-2.6-.7-.7-2.6z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5l-3 14"/>',
  megaphone: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9.5a3.5 3.5 0 0 1 0 5"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  agency: '<rect x="3.5" y="7" width="17" height="12" rx="2"/><path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M3.5 12.5h17"/>',
};
export const icon = (k, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k] || ''}</svg>`;
export const badge = (status) => { const s = STATUS[status]; return s ? `<span class="st st-${s.tone}">${esc(s.label)}</span>` : ''; };
/** A table cell: a tick when available, otherwise early access. */
export const capCell = (status) => (STATUS[status] ? badge(status) : `<span class="cap-yes" aria-label="Included">✓</span>`);

function nav(path) {
  const on = (p) => (path === p || path.startsWith(p + '/') ? ' aria-current="page"' : '');
  const item = (href, ic, title, sub, status) => `<a class="mm-item" href="${href}"><span class="mm-ic">${icon(ic, 18)}</span><span><b>${esc(title)} ${status && status !== 'live' ? badge(status) : ''}</b><span>${esc(sub)}</span></span></a>`;
  return `<nav class="mainnav" id="mainnav" aria-label="Main">
    <div class="nv"><button type="button" class="nv-btn"${on('/features')} aria-expanded="false">Features ${icon('chevron', 15)}</button>
      <div class="mega wide"><p class="mega-intro">Everything below is included in your Tharam plan.</p><div class="mega-grid">${PRODUCTS.map((p) => item(`/features/${p.slug}`, p.icon, p.name, p.short, p.status)).join('')}</div>
        <div class="mega-foot two"><a href="/checks">See every check we run ${icon('arrow', 15)}</a><a href="/commerce-assurance">Why Tharam ${icon('arrow', 15)}</a></div></div></div>
    <div class="nv"><button type="button" class="nv-btn"${on('/platforms') || on('/marketplaces') || on('/managed')} aria-expanded="false">Solutions ${icon('chevron', 15)}</button>
      <div class="mega solutions"><div class="sol-cols">
        <div><p class="mega-label">Your store platform</p><div class="mega-list">${PLATFORMS.map((p) => `<a href="/platforms/${p.slug}"><span>${esc(p.name)}</span>${badge(p.status)}</a>`).join('')}</div>
          <a class="mega-foot" href="/platforms">Compare platforms ${icon('arrow', 15)}</a></div>
        <div><p class="mega-label">Also selling on</p><div class="mega-list">${MARKETPLACES.map((m) => `<a href="/marketplaces/${m.slug}"><span>${esc(m.name)}</span>${badge(m.status)}</a>`).join('')}</div>
          <a class="mega-foot" href="/marketplaces">About marketplaces ${icon('arrow', 15)}</a></div>
        <div><p class="mega-label">Done for you</p>${item('/managed', 'tool', 'Managed service', 'Our team watches your store, fixes what breaks and checks every change.')}
          <p class="mega-label">Built for</p>${item('/demo', 'agency', 'Agencies and freelancers', 'Every client store in one place, with reports to share.')}${item('/demo', 'code', 'App and theme developers', 'Make sure your app or theme works on real stores.')}</div>
      </div></div></div>
    <a class="nv-link" href="/pricing"${on('/pricing')}>Pricing</a>
    <a class="nv-link show-sm" href="/demo">Book a demo</a>
    <a class="nv-link show-sm" href="/app">Log in</a>
  </nav>`;
}

function footer() {
  const col = (h, links) => `<div><h4>${esc(h)}</h4>${links.map(([href, l]) => `<a href="${href}">${esc(l)}</a>`).join('')}</div>`;
  return `<footer class="site-foot"><div class="wrap">
    <div class="sf-brand"><img src="/assets/brand/tharam-logo-dark.svg" alt="Tharam" width="112" height="32"><p>AI-powered store checks for online sellers. Make sure customers can always buy from you.</p>
      <a class="btn small light" href="/#check">Check my store free</a></div>
    ${col('Features', PRODUCTS.map((p) => [`/features/${p.slug}`, p.name]).concat([['/checks', 'Every check']]))}
    ${col('Platforms', PLATFORMS.slice(0, 6).map((p) => [`/platforms/${p.slug}`, p.name]).concat([['/platforms', 'All platforms']]))}
    ${col('Marketplaces', MARKETPLACES.map((m) => [`/marketplaces/${m.slug}`, m.name]))}
    ${col('Company', [['/commerce-assurance', 'Why Tharam'], ['/managed', 'Managed service'], ['/sale-ready', 'Black Friday readiness'], ['/pricing', 'Pricing'], ['/demo', 'Book a demo'], ['/bot', 'Our test browser'], ['mailto:hello@tharam.store', 'Contact'], ['/de', 'Deutsch'], ['/fr', 'Français'], ['/es', 'Español']])}
    </div><div class="wrap sf-legal"><span>© 2026 Tharam</span><span><a href="/privacy">Privacy</a><a href="/terms">Terms</a></span></div></footer>`;
}

const SCRIPT = `<script>
(function(){
  var navs=[].slice.call(document.querySelectorAll('.nv'));
  function close(except){navs.forEach(function(n){if(n!==except){n.classList.remove('open');n.querySelector('.nv-btn').setAttribute('aria-expanded','false');}});}
  navs.forEach(function(n){var b=n.querySelector('.nv-btn');
    b.addEventListener('click',function(e){e.stopPropagation();var o=!n.classList.contains('open');close(n);n.classList.toggle('open',o);b.setAttribute('aria-expanded',String(o));});});
  document.addEventListener('click',function(e){if(!e.target.closest('.nv'))close();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){close();document.body.classList.remove('menu-open');}});
  var mb=document.getElementById('menu-toggle');
  if(mb)mb.addEventListener('click',function(){var o=document.body.classList.toggle('menu-open');mb.setAttribute('aria-expanded',String(o));});
  var f=document.getElementById('check-form');
  // Pages in other languages give their own words in data-empty, data-starting and data-failed.
  if(f)f.addEventListener('submit',async function(e){e.preventDefault();var err=document.getElementById('check-err'),btn=f.querySelector('button'),url=f.url.value.trim(),label=btn.textContent;err.textContent='';
    if(!url){err.textContent=f.dataset.empty||'Enter your store address, like yourstore.com';return;}
    btn.disabled=true;btn.textContent=f.dataset.starting||'Starting…';
    try{var r=await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url})});var j=await r.json();if(!r.ok)throw new Error(j.error||f.dataset.failed||'Could not start the check');location.href='/scan/'+j.runId;}
    catch(x){err.textContent=x.message;btn.disabled=false;btn.textContent=label;}});
  [].slice.call(document.querySelectorAll('[data-tabs]')).forEach(function(t){t.addEventListener('click',function(e){var b=e.target.closest('[data-tab]');if(!b)return;
    [].slice.call(t.querySelectorAll('[data-tab]')).forEach(function(x){x.setAttribute('aria-selected',String(x===b));});
    [].slice.call(t.querySelectorAll('[data-pane]')).forEach(function(p){p.hidden=p.dataset.pane!==b.dataset.tab;});});});
  [].slice.call(document.querySelectorAll('form[data-waitlist]')).forEach(function(w){w.addEventListener('submit',async function(e){e.preventDefault();var msg=w.querySelector('.wl-msg'),btn=w.querySelector('button');btn.disabled=true;
    try{var r=await fetch('/api/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:w.email.value.trim(),url:(w.url&&w.url.value)||'',source:w.dataset.waitlist})});var j=await r.json();if(!r.ok)throw new Error(j.error||'Please try again');msg.textContent='You are on the list. We will email you when it opens.';w.reset();}
    catch(x){msg.textContent=x.message;}btn.disabled=false;});});
})();
</script>`;

/** Wraps page content in the site layout. */
export function layout({ title, description = '', path = '/', body, noindex = false, extraHead = '', scripts = '', lang = 'en', alternates = null }) {
  const full = title ? `${title} – Tharam` : 'Tharam – Make sure customers can always buy from you';
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="https://tharam.store${path === '/' ? '/' : path}">`}${alternates ? Object.entries(alternates).map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="https://tharam.store${h}">`).join('') : ''}
<meta property="og:title" content="${esc(full)}"><meta property="og:description" content="${esc(description)}"><meta property="og:image" content="https://tharam.store/assets/og.png">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/fonts/fonts.css?v=${VERSION}"><link rel="stylesheet" href="/assets/site.css?v=${VERSION}"><link rel="stylesheet" href="/assets/www.css?v=${VERSION}">${extraHead}</head>
<body class="www">
<header class="site-top"><div class="wrap">
  <a class="brand" href="/" aria-label="Tharam home"><img src="/assets/brand/tharam-logo.svg" width="118" height="34" alt="Tharam"></a>
  ${nav(path)}
  <div class="top-actions"><a class="nv-link hide-sm" href="/app">Log in</a><a class="btn small secondary hide-sm" href="/demo">Book a demo</a><a class="btn small" href="/#check">Free store check</a>
    <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Menu" aria-expanded="false" aria-controls="mainnav">${icon('menu', 22)}</button></div>
</div></header>
${body}
${footer()}
${SCRIPT}${scripts}
</body></html>`;
}
