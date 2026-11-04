/**
 * The interactive demo on the homepage: sample data only, no real app behind it.
 * Built around moments a shop owner recognises: watching a test shop the store, the alert that arrives
 * when a button breaks, a design checked before publishing, product mistakes, the laws where they sell,
 * and how much money was at risk.
 */
import { icon } from './layout.js';

const ISSUES = [
  { id: 'i1', sev: 'fail', title: '“Brass Diya Set” is priced at ₹0', what: 'Customers can order it for free. The price changed in yesterday’s price import.', fix: 'Open the product in Shopify, set the price back to ₹1,299 and save.' },
  { id: 'i2', sev: 'fail', title: 'Cookie banner missing for visitors from Germany', what: 'The Meta pixel loads before visitors agree to cookies, which German law doesn’t allow.', fix: 'Turn on the cookie banner in Shopify (Settings → Customer privacy) and show it in the EU.' },
  { id: 'i3', sev: 'warn', title: 'Homepage is slow on phones (4.1 seconds)', what: 'Most shoppers leave if a page takes more than 3 seconds. The new reviews app adds 1.6 seconds.', fix: 'Ask the reviews app to load after the page, or switch to their “lite” widget.' },
  { id: 'i4', sev: 'warn', title: '2 products have no photos', what: '“Cotton Dupatta” and “Jute Tote Bag” show a blank image.', fix: 'Add at least one photo to each product in Shopify → Products → Media.' },
];
const PRODUCTS = [
  ['Organic Cotton Kurta', '₹1,499', 'In stock', 'ok', ''],
  ['Handwoven Silk Saree', '₹8,999', 'In stock', 'changed', 'Description edited today'],
  ['Brass Diya Set', '₹0', 'In stock', 'problem', 'Priced at ₹0'],
  ['Cotton Dupatta', '₹699', 'In stock', 'problem', 'No photos'],
  ['Jute Tote Bag', '₹449', 'Low stock', 'problem', 'No photos'],
  ['Block-print Bedsheet', '₹2,199', 'In stock', 'changed', 'Price ₹2,499 → ₹2,199'],
  ['Festive Gift Box', '₹1,999', 'In stock', 'problem', '“Sale” price is higher than before'],
  ['Terracotta Planter', '₹899', 'Sold out', 'changed', 'Sold out since this morning'],
  ['Linen Shirt', '₹1,799', 'In stock', 'ok', ''],
];
const LAWS = {
  de: { name: 'Germany', rules: [
    ['pass', 'Impressum (legal notice) on every page', ''],
    ['pass', 'Right of withdrawal (Widerrufsbelehrung)', ''],
    ['fail', '“Vertrag widerrufen” button', 'Required since 19 June 2026. Add a clearly labelled link in your footer that opens a short withdrawal form.'],
    ['pass', 'Prices say “inkl. MwSt.” and show shipping costs', ''],
    ['pass', 'Unit prices for products sold by weight', ''],
    ['fail', 'No tracking before cookie consent', 'The Meta pixel fires before visitors agree. Turn on Shopify’s cookie banner, or set your consent app to block it.'],
    ['warn', 'No outdated EU dispute (ODR) link', 'The EU platform closed in July 2025. Remove the link from your Impressum.'],
    ['pass', 'Shopping works with a keyboard', ''],
  ] },
  us: { name: 'United States', rules: [
    ['pass', 'Add to cart works with a keyboard', ''],
    ['pass', 'Shoppers can zoom in on phones', ''],
    ['pass', 'Cart page passes accessibility checks', ''],
    ['fail', 'Accessibility statement published', 'Add a short page explaining what you’ve done for accessibility and how customers can ask for help.'],
    ['warn', 'No overlay widget relied on', 'An accessibility widget is installed. It doesn’t fix your theme; many sued stores had one.'],
    ['pass', '“Do not sell or share my personal information” link', ''],
  ] },
  uk: { name: 'United Kingdom', rules: [
    ['pass', 'Cookie banner shown to visitors', ''],
    ['fail', 'No tracking before cookie consent', 'The Meta pixel fires before visitors agree. Set your consent app to block it until they accept.'],
    ['pass', 'Shopping works with a keyboard', ''],
    ['pass', 'Page language is set', ''],
    ['fail', 'Accessibility statement published', 'Add a short accessibility page and link it in your footer.'],
  ] },
};
const lawCount = (k) => { const r = LAWS[k].rules; return [r.filter((x) => x[0] === 'pass').length, r.length]; };

const pane = (k, html, on) => `<div class="dm-pane" data-dp="${k}" ${on ? '' : 'hidden'}>${html}</div>`;
const head = (k, title, right = '') => `<div class="dm-head"><div><span class="dm-k">${k}</span><h4>${title}</h4></div>${right}</div>`;

/* ---------- Overview ---------- */
const BUY = [100, 100, 96, 100, 100, 99, 100, 100, 92, 100, 100, 100, 100, 100];
const overview = `
  ${head('Overview', 'Kaveri Handlooms', `<button type="button" class="dm-btn" data-run>${icon('pulse', 15)}Run a check now</button>`)}
  <div class="dm-score">
    <div class="sc lead"><span>Customers could buy</span><b class="good">99.4%</b><em>last 7 days</em><div class="sc-bars">${BUY.map((v) => `<i class="${v >= 99 ? 'g' : v >= 95 ? 'm' : 'b'}" style="--h:${v}"></i>`).join('')}</div></div>
    <div class="sc"><span>Money at risk</span><b>₹8,000</b><em>4 hours customers couldn’t buy</em></div>
    <div class="sc"><span>Time to fix</span><b>40 min</b><em>typical, this month</em></div>
    <div class="sc"><span>Laws where you sell</span><b class="mid">5/8</b><em>Germany rules met</em></div>
  </div>
  <div class="dm-list" data-list><p class="dm-lh">What needs fixing <em>Click one</em></p>
    ${ISSUES.map((i) => `<button type="button" class="dm-issue" data-issue="${i.id}"><span class="dm-sev ${i.sev}">${i.sev === 'fail' ? 'Fix' : 'Check'}</span><span class="dm-it">${i.title}</span>${icon('chevron', 15)}</button>
      <div class="dm-detail" data-detail="${i.id}" hidden><p>${i.what}</p><p class="dm-fix"><b>How to fix:</b> ${i.fix}</p></div>`).join('')}</div>
  <div class="dm-run" data-runbox hidden><p class="dm-lh">Checking your store like a customer…</p><ol>
    ${['Opening your store on a phone', 'Searching for “kurta”', 'Adding a product to the cart', 'Opening checkout (stops before payment)', 'Checking every product and price', 'Checking the rules in Germany', 'Checking speed and Google'].map((t) => `<li>${t}</li>`).join('')}</ol></div>`;

/* ---------- Watch a test ---------- */
const STEPS = [
  ['home', 'Open the store on a phone', '1.4 s'],
  ['search', 'Search for “kurta”', '0.9 s'],
  ['product', 'Open a product and pick size M', '1.1 s'],
  ['atc', 'Tap Add to cart', '0.6 s'],
  ['cart', 'Check the cart shows the kurta', '0.8 s'],
  ['checkout', 'Open checkout, stop before payment', '1.7 s'],
];
const card = (n, price) => `<div class="ph-card"><i></i><b>${n}</b><span>${price}</span></div>`;
const phone = `<div class="ph" data-phone>
  <div class="ph-top"><span>9:41</span><span class="ph-url">kaverihandlooms.com</span></div>
  <div class="ph-scr" data-scr="home"><div class="ph-hero"><b>Handmade in India</b><span>Festive collection is here</span></div><div class="ph-search">Search products…</div><div class="ph-grid">${card('Silk Saree', '₹8,999')}${card('Linen Shirt', '₹1,799')}</div></div>
  <div class="ph-scr" data-scr="search" hidden><div class="ph-search on">kurta<span class="caret"></span></div><p class="ph-note">3 results</p><div class="ph-grid">${card('Cotton Kurta', '₹1,499')}${card('Silk Kurta', '₹3,299')}</div></div>
  <div class="ph-scr" data-scr="product" hidden><div class="ph-img"></div><b class="ph-title">Organic Cotton Kurta</b><span class="ph-price">₹1,499</span>
    <div class="ph-sizes"><span>S</span><span class="sel">M</span><span>L</span></div><button type="button" class="ph-atc" data-atc>Add to cart</button><p class="ph-err" data-err hidden>Nothing was added to the cart.</p></div>
  <div class="ph-scr" data-scr="cart" hidden><b class="ph-title">Your cart</b><div class="ph-line"><i></i><span>Organic Cotton Kurta · M</span><b>₹1,499</b></div><button type="button" class="ph-atc">Check out</button></div>
  <div class="ph-scr" data-scr="checkout" hidden><b class="ph-title">${icon('lock', 13)} Checkout</b><div class="ph-field">Email</div><div class="ph-field">Delivery address</div><p class="ph-note">Tharam stops here. No order is placed.</p></div>
  <div class="ph-tap" data-tap hidden></div>
  <div class="ph-notif" data-notif hidden><b>Tharam · now</b><span>Urgent: Add to cart stopped working on Kaveri Handlooms</span></div>
</div>`;
const watch = `
  ${head('Watch a test', 'See exactly what we do in your store', '')}
  <div class="dm-watch">${phone}
    <div class="dm-steps"><div class="dm-tools tight"><button type="button" class="dm-btn" data-play>${icon('pulse', 15)}Start the test</button>
      <label class="dm-switch"><input type="checkbox" data-break><span></span>Simulate a broken app update</label></div>
      <ol class="dm-steplist" data-steps>${STEPS.map(([k, t, s]) => `<li data-step="${k}"><span class="st-dot"></span><span class="st-t">${t}</span><span class="st-s">${s}</span></li>`).join('')}</ol>
      <div class="dm-result" data-result hidden></div></div></div>`;

/* ---------- Alerts ---------- */
const alertsPane = `
  ${head('Alerts', 'What you get when something breaks')}
  <div class="dm-seg" data-seg="alert">${[['email', 'Email'], ['slack', 'Slack'], ['phone', 'On your phone']].map(([k, l], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
  <div class="dm-alert" data-alert="email"><div class="mail"><div class="mail-h"><b>Tharam</b><span>to you · 2:14 PM</span></div>
    <p class="mail-s">Urgent: Check failed on Kaveri Handlooms: Add to cart works</p>
    <p>🔴 <b>Add to cart works:</b> Clicking “Add to cart” on “Organic Cotton Kurta” did not add anything, but Shopify’s cart accepts the item. Something on the page (theme code or an app) is breaking the button.</p>
    <p class="mail-fix">Fix: Check recent theme edits and app updates. “QuickCart Upsell” was updated 40 minutes ago.</p>
    <span class="mail-btn">Open report with screenshots</span>
    <p class="mail-foot">We checked twice before telling you. You’ll get one more email when it works again.</p></div></div>
  <div class="dm-alert" data-alert="slack" hidden><div class="slack"><div class="sl-row"><span class="sl-av">T</span><div><b>Tharam</b> <span class="sl-time">2:14 PM</span>
    <p><b>Urgent: Check failed on Kaveri Handlooms: Add to cart works</b></p><p>🔴 Clicking “Add to cart” did not add anything. Fix: check app updates (“QuickCart Upsell” updated 40 min ago).</p><span class="sl-link">Full report with screenshots</span></div></div>
    <div class="sl-row later"><span class="sl-av">T</span><div><b>Tharam</b> <span class="sl-time">2:52 PM</span><p>🟢 <b>Fixed on Kaveri Handlooms:</b> Add to cart works. Customers couldn’t buy for 38 minutes.</p></div></div></div></div>
  <div class="dm-alert" data-alert="phone" hidden><div class="lock"><span class="lk-time">2:14</span><span class="lk-date">Wednesday, 4 November</span>
    <div class="lk-n"><b>Mail · Tharam</b><span>Urgent: Add to cart stopped working on Kaveri Handlooms</span></div>
    <div class="lk-n dim"><b>Mail · Tharam</b><span>Fixed: Add to cart works again. Down for 38 minutes.</span></div></div></div>
  <p class="dm-note">One alert when something breaks, one when it’s fixed. Never the same problem twice.</p>`;

/* ---------- Safe to publish ---------- */
const shopMock = (variant) => `<div class="dm-shop ${variant}">
  <div class="sh-bar"><i></i><span></span><span></span><span></span></div>
  ${variant !== 'current' ? '<div class="sh-sale">DIWALI SALE · 40% OFF</div>' : ''}
  <div class="sh-hero"><b>Handmade in India</b><span>New festive collection</span></div>
  <div class="sh-grid">${[1, 2, 3].map((n) => `<div class="sh-card"><i></i><span></span><em class="${variant !== 'current' && n === 1 ? 'broken' : ''}">Add to cart</em></div>`).join('')}</div>
  ${variant === 'diff' ? '<span class="sh-mark m1"></span><span class="sh-mark m2"></span>' : ''}</div>`;
const publish = `
  ${head('Safe to publish', 'Diwali homepage (new design)')}
  <div class="dm-verdict"><span class="dm-vic">!</span><div><b>Don’t publish yet</b><p>Add to cart doesn’t work on phones in the new design. Everything else is fine.</p></div>
    <div class="dm-scores"><span>Now<b>98</b></span>${icon('arrow', 15)}<span>New<b class="bad">46</b></span></div></div>
  <div class="dm-tools"><div class="dm-seg" data-seg="view">${[['current', 'Current store'], ['new', 'New design'], ['diff', 'Differences']].map(([k, l], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 1}">${l}</button>`).join('')}</div>
    <div class="dm-seg" data-seg="device">${[['desk', 'Computer'], ['phone', 'Phone']].map(([k, l], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 1}">${l}</button>`).join('')}</div></div>
  <div class="dm-stage phone" data-stage>${['current', 'new', 'diff'].map((v) => `<div data-view="${v}" ${v === 'new' ? '' : 'hidden'}>${shopMock(v)}</div>`).join('')}</div>
  <div class="dm-pubrows"><span class="dm-sev fail">Breaks</span>Add to cart on phones<span class="dm-sev ok">Same</span>Search, cart, checkout, speed<span class="dm-sev warn">Changed</span>Homepage looks 18% different</div>`;

/* ---------- Products ---------- */
const products = `
  ${head('Products', '48 products checked 3 hours ago')}
  <div class="dm-seg chips" data-seg="filter">${[['all', 'All'], ['problem', 'Problems (4)'], ['changed', 'Changed today (3)']].map(([k, l], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
  <table class="dm-table"><thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Note</th></tr></thead><tbody>
    ${PRODUCTS.map(([n, p, s, k, note]) => `<tr data-kind="${k}"><td><span class="dm-thumb ${note === 'No photos' ? 'none' : ''}"></span>${n}</td><td class="${p === '₹0' ? 'bad' : ''}">${p}</td><td>${s}</td><td>${note ? `<span class="dm-tag ${k}">${note}</span>` : '<span class="dm-ok">All good</span>'}</td></tr>`).join('')}</tbody></table>`;

/* ---------- Laws where you sell ---------- */
const lawList = (k) => LAWS[k].rules.map(([st, t, fix]) => `<div class="law ${st}"><span class="law-i">${st === 'pass' ? '✓' : st === 'fail' ? '✕' : '!'}</span><div><b>${t}</b>${fix ? `<p>${fix}</p>` : ''}</div></div>`).join('');
const laws = `
  ${head('Laws where you sell', 'Rules checked in every full check')}
  <div class="dm-seg chips" data-seg="law">${Object.entries(LAWS).map(([k, v], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 0}">${v.name} · ${lawCount(k).join('/')}</button>`).join('')}</div>
  ${Object.keys(LAWS).map((k, i) => `<div class="dm-laws" data-law="${k}" ${i ? 'hidden' : ''}><p class="dm-lh">${lawCount(k)[0]} of ${lawCount(k)[1]} rules met in ${LAWS[k].name}</p>${lawList(k)}</div>`).join('')}
  <p class="dm-note">Checks, not legal advice: we show exactly what we saw, so you or your lawyer can decide.</p>`;

/* ---------- Reports ---------- */
const DAYS = { day: [100, 100, 96, 100, 100, 100, 100], week: [100, 98, 100, 86, 92, 100, 100] };
const reports = `
  ${head('Reports', 'Today’s report', '<label class="dm-select">Compare with <select data-compare><option value="day">Yesterday</option><option value="week">Same day last week</option></select></label>')}
  <div class="dm-counts"><div class="c-new"><b data-n="new">1</b><span>newly broken</span></div><div class="c-fixed"><b data-n="fixed">2</b><span>fixed</span></div><div class="c-still"><b data-n="still">0</b><span>still broken</span></div></div>
  <p class="dm-lh">Customers could buy, last 7 days</p>
  <div class="dm-bars" data-bars>${DAYS.day.map((v, i) => `<i style="--h:${v}" title="${['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Today'].at(i)}: ${v}%"><span>${v}%</span></i>`).join('')}</div>
  <div class="dm-days">${['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Today'].map((d) => `<span>${d}</span>`).join('')}</div>`;

const NAV = [['overview', 'pulse', 'Overview'], ['watch', 'eye', 'Watch a test'], ['alerts', 'megaphone', 'Alerts'], ['publish', 'publish', 'Safe to publish'], ['products', 'catalog', 'Products'], ['laws', 'globe', 'Laws where you sell'], ['reports', 'reports', 'Reports']];
export const demoMarkup = `<div class="demo" data-demo>
  <div class="demo-chrome"><span class="dots"><i></i><i></i><i></i></span><span class="demo-url">app.tharam.store</span><span class="demo-tag">Interactive demo · sample store</span></div>
  <div class="demo-body">
    <nav class="demo-rail" aria-label="Demo sections">
      <span class="dr-store"><i></i>Kaveri Handlooms</span>
      ${NAV.map(([k, ic, l], i) => `<button type="button" data-go="${k}" aria-current="${i === 0}">${icon(ic, 17)}<span>${l}</span>${k === 'watch' ? '<em class="dr-new">Try it</em>' : ''}</button>`).join('')}
    </nav>
    <div class="demo-main">${pane('overview', overview, true)}${pane('watch', watch)}${pane('alerts', alertsPane)}${pane('publish', publish)}${pane('products', products)}${pane('laws', laws)}${pane('reports', reports)}</div>
  </div>
  <div class="demo-toast" data-toast hidden></div>
</div>`;

export const demoScript = `<script>
(function(){
  var d=document.querySelector('[data-demo]'); if(!d) return;
  var $=function(s,r){return (r||d).querySelector(s)}, $$=function(s,r){return [].slice.call((r||d).querySelectorAll(s))};
  var DAYS=${JSON.stringify(DAYS)}, COUNTS={day:[1,2,0],week:[1,4,0]}, STEPS=${JSON.stringify(STEPS.map((s) => s[0]))};
  function toast(t){var el=$('[data-toast]');el.textContent=t;el.hidden=false;clearTimeout(el._t);el._t=setTimeout(function(){el.hidden=true},3600);}
  function go(k){$$('[data-go]').forEach(function(b){b.setAttribute('aria-current',String(b.dataset.go===k))});$$('[data-dp]').forEach(function(p){p.hidden=p.dataset.dp!==k});$('.demo-main').scrollTop=0;}
  // Watch a test: plays the shopping trip on the phone, step by step.
  var playing=false;
  function screen(k){$$('[data-scr]').forEach(function(s){s.hidden=s.dataset.scr!==k});}
  function play(btn){
    if(playing)return;playing=true;btn.disabled=true;var broken=$('[data-break]').checked;
    var res=$('[data-result]');res.hidden=true;$('[data-notif]').hidden=true;$('[data-err]').hidden=true;$('[data-atc]').classList.remove('bad');
    $$('[data-step]').forEach(function(li){li.className=''});var i=0;
    (function next(){
      if(i>0){var prev=$('[data-step="'+STEPS[i-1]+'"]');prev.className='done';}
      if(i>=STEPS.length){playing=false;btn.disabled=false;res.className='dm-result ok';res.innerHTML='<b>Customers can buy.</b> Every step worked on a phone. Next test in 3 hours.';res.hidden=false;return;}
      var k=STEPS[i],li=$('[data-step="'+k+'"]');li.className='now';
      var scr=k==='atc'?'product':k;screen(scr);
      if(k==='atc'){var tap=$('[data-tap]');tap.hidden=false;setTimeout(function(){tap.hidden=true},500);
        if(broken){setTimeout(function(){li.className='fail';$('[data-atc]').classList.add('bad');$('[data-err]').hidden=false;
          $$('[data-step]').forEach(function(x,j){if(j>i)x.className='skip'});
          setTimeout(function(){$('[data-notif]').hidden=false;},700);
          res.className='dm-result bad';res.innerHTML='<b>Customers can’t buy.</b> Add to cart stopped working, most likely after the “QuickCart Upsell” app update 40 minutes ago. We checked again to be sure, then alerted you. <button type="button" class="dm-link" data-go="alerts">See the alert</button>';res.hidden=false;playing=false;btn.disabled=false;},900);return;}}
      i++;setTimeout(next,950);
    })();
  }
  d.addEventListener('click',function(e){
    var g=e.target.closest('[data-go]');
    if(g){go(g.dataset.go);return;}
    var p=e.target.closest('[data-play]');
    if(p){play(p);return;}
    var is=e.target.closest('[data-issue]');
    if(is){var det=$('[data-detail="'+is.dataset.issue+'"]');var open=det.hidden;$$('[data-detail]').forEach(function(x){x.hidden=true});$$('[data-issue]').forEach(function(x){x.classList.remove('open')});det.hidden=!open;is.classList.toggle('open',open);return;}
    var run=e.target.closest('[data-run]');
    if(run){if(run.disabled)return;run.disabled=true;var box=$('[data-runbox]'),list=$('[data-list]');list.hidden=true;box.hidden=false;var steps=$$('li',box);steps.forEach(function(s){s.className=''});var i=0;
      (function next(){if(i>0)steps[i-1].className='done';if(i<steps.length){steps[i].className='now';i++;setTimeout(next,600);}else{setTimeout(function(){box.hidden=true;list.hidden=false;run.disabled=false;toast('Check finished: customers can buy. 2 things still need fixing.');},500);}})();return;}
    var b=e.target.closest('[data-seg] button');
    if(b){var seg=b.closest('[data-seg]');$$('button',seg).forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});var k=seg.dataset.seg,v=b.dataset.v;
      if(k==='view')$$('[data-view]').forEach(function(x){x.hidden=x.dataset.view!==v});
      if(k==='device')$('[data-stage]').className='dm-stage '+v;
      if(k==='filter')$$('tr[data-kind]').forEach(function(r){r.hidden=!(v==='all'||r.dataset.kind===v)});
      if(k==='alert')$$('[data-alert]').forEach(function(x){x.hidden=x.dataset.alert!==v});
      if(k==='law')$$('[data-law]').forEach(function(x){x.hidden=x.dataset.law!==v});}
  });
  var sel=$('[data-compare]');
  if(sel)sel.addEventListener('change',function(){var v=sel.value,c=COUNTS[v];['new','fixed','still'].forEach(function(n,i){$('[data-n="'+n+'"]').textContent=c[i]});
    $$('[data-bars] i').forEach(function(bar,i){var x=DAYS[v][i];bar.style.setProperty('--h',x);bar.querySelector('span').textContent=x+'%';bar.title=bar.title.replace(/\\d+%$/,x+'%')});});
})();
</script>`;
