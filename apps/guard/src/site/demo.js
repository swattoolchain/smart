/**
 * A small interactive demo of the Tharam app for the homepage: sample data only, no real app behind it.
 * Visitors can click around Overview, Safe to publish, Products and Reports.
 */
import { icon } from './layout.js';

const ISSUES = [
  { id: 'i1', sev: 'fail', title: '“Brass Diya Set” is priced at ₹0', what: 'Customers can order it for free. It changed in yesterday’s price import.', fix: 'Open the product in Shopify, set the price back to ₹1,299 and save.' },
  { id: 'i2', sev: 'warn', title: 'Homepage is slow on phones (4.1 seconds)', what: 'Most shoppers leave if a page takes more than 3 seconds. The new reviews app adds 1.6 seconds.', fix: 'Ask the reviews app to load after the page, or switch to their “lite” widget.' },
  { id: 'i3', sev: 'warn', title: '2 products have no photos', what: '“Cotton Dupatta” and “Jute Tote Bag” show a blank image.', fix: 'Add at least one photo to each product in Shopify → Products → Media.' },
];
const PRODUCTS = [
  ['Organic Cotton Kurta', '₹1,499', 'In stock', 'ok', ''],
  ['Handwoven Silk Saree', '₹8,999', 'In stock', 'changed', 'Description edited today'],
  ['Brass Diya Set', '₹0', 'In stock', 'problem', 'Priced at ₹0'],
  ['Cotton Dupatta', '₹699', 'In stock', 'problem', 'No photos'],
  ['Jute Tote Bag', '₹449', 'Low stock', 'problem', 'No photos'],
  ['Block-print Bedsheet', '₹2,199', 'In stock', 'changed', 'Price ₹2,499 → ₹2,199'],
  ['Terracotta Planter', '₹899', 'Sold out', 'changed', 'Sold out since this morning'],
  ['Linen Shirt', '₹1,799', 'In stock', 'ok', ''],
];

const pane = (k, html, on) => `<div class="dm-pane" data-dp="${k}" ${on ? '' : 'hidden'}>${html}</div>`;

const overview = `
  <div class="dm-head"><div><span class="dm-k">Overview</span><h4>Kaveri Handlooms</h4></div><button type="button" class="dm-btn" data-run>${icon('pulse', 15)}Run a check now</button></div>
  <div class="dm-hero"><div class="dm-dial" style="--v:92"><b>92</b><span>health</span></div>
    <div><span class="dm-pill ok">Customers can buy</span><p class="dm-sum">Everything works. <b>1 thing to fix</b> and 2 worth a look.</p>
      <div class="dm-kpis"><span><b>99.4%</b> could buy this week</span><span><b>38 min</b> to the next check</span></div></div></div>
  <div class="dm-list" data-list><p class="dm-lh">What needs fixing <em>Click one</em></p>
    ${ISSUES.map((i) => `<button type="button" class="dm-issue" data-issue="${i.id}"><span class="dm-sev ${i.sev}">${i.sev === 'fail' ? 'Fix' : 'Check'}</span><span class="dm-it">${i.title}</span>${icon('chevron', 15)}</button>
      <div class="dm-detail" data-detail="${i.id}" hidden><p>${i.what}</p><p class="dm-fix"><b>How to fix:</b> ${i.fix}</p></div>`).join('')}</div>
  <div class="dm-run" data-runbox hidden><p class="dm-lh">Checking your store like a customer…</p><ol>
    ${['Opening your store on a phone', 'Searching for “kurta”', 'Adding a product to the cart', 'Opening checkout (stops before payment)', 'Checking every product and price', 'Checking speed and Google'].map((t) => `<li>${t}</li>`).join('')}</ol></div>`;

const shopMock = (variant) => `<div class="dm-shop ${variant}">
  <div class="sh-bar"><i></i><span></span><span></span><span></span></div>
  ${variant !== 'current' ? '<div class="sh-sale">DIWALI SALE · 40% OFF</div>' : ''}
  <div class="sh-hero"><b>Handmade in India</b><span>New festive collection</span></div>
  <div class="sh-grid">${[1, 2, 3].map((n) => `<div class="sh-card"><i></i><span></span><em class="${variant !== 'current' && n === 1 ? 'broken' : ''}">Add to cart</em></div>`).join('')}</div>
  ${variant === 'diff' ? '<span class="sh-mark m1"></span><span class="sh-mark m2"></span>' : ''}</div>`;

const publish = `
  <div class="dm-head"><div><span class="dm-k">Safe to publish</span><h4>Diwali homepage (new design)</h4></div></div>
  <div class="dm-verdict"><span class="dm-vic">!</span><div><b>Don’t publish yet</b><p>Add to cart doesn’t work on phones in the new design. Everything else is fine.</p></div>
    <div class="dm-scores"><span>Now<b>98</b></span>${icon('arrow', 15)}<span>New<b class="bad">46</b></span></div></div>
  <div class="dm-tools"><div class="dm-seg" data-seg="view">${[['current', 'Current store'], ['new', 'New design'], ['diff', 'Differences']].map(([k, l], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 1}">${l}</button>`).join('')}</div>
    <div class="dm-seg" data-seg="device">${[['desk', 'Computer'], ['phone', 'Phone']].map(([k, l], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 1}">${l}</button>`).join('')}</div></div>
  <div class="dm-stage phone" data-stage>${['current', 'new', 'diff'].map((v) => `<div data-view="${v}" ${v === 'new' ? '' : 'hidden'}>${shopMock(v)}</div>`).join('')}</div>`;

const products = `
  <div class="dm-head"><div><span class="dm-k">Products</span><h4>48 products checked 3 hours ago</h4></div></div>
  <div class="dm-seg chips" data-seg="filter">${[['all', 'All'], ['problem', 'Problems (3)'], ['changed', 'Changed today (3)']].map(([k, l], i) => `<button type="button" data-v="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
  <table class="dm-table"><thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Note</th></tr></thead><tbody>
    ${PRODUCTS.map(([n, p, s, k, note]) => `<tr data-kind="${k}"><td><span class="dm-thumb ${note === 'No photos' ? 'none' : ''}"></span>${n}</td><td class="${p === '₹0' ? 'bad' : ''}">${p}</td><td>${s}</td><td>${note ? `<span class="dm-tag ${k}">${note}</span>` : '<span class="dm-ok">All good</span>'}</td></tr>`).join('')}</tbody></table>`;

const DAYS = { day: [100, 100, 96, 100, 100, 100, 100], week: [100, 98, 100, 86, 92, 100, 100] };
const reports = `
  <div class="dm-head"><div><span class="dm-k">Reports</span><h4>Today’s report</h4></div>
    <label class="dm-select">Compare with <select data-compare><option value="day">Yesterday</option><option value="week">Same day last week</option></select></label></div>
  <div class="dm-counts"><div class="c-new"><b data-n="new">1</b><span>newly broken</span></div><div class="c-fixed"><b data-n="fixed">2</b><span>fixed</span></div><div class="c-still"><b data-n="still">0</b><span>still broken</span></div></div>
  <p class="dm-lh">Customers could buy, last 7 days</p>
  <div class="dm-bars" data-bars>${DAYS.day.map((v, i) => `<i style="--h:${v}" title="${['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Today'].at(i)}: ${v}%"><span>${v}%</span></i>`).join('')}</div>
  <div class="dm-days">${['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Today'].map((d) => `<span>${d}</span>`).join('')}</div>`;

export const demoMarkup = `<div class="demo" data-demo>
  <div class="demo-chrome"><span class="dots"><i></i><i></i><i></i></span><span class="demo-url">app.tharam.store</span><span class="demo-tag">Interactive demo · sample store</span></div>
  <div class="demo-body">
    <nav class="demo-rail" aria-label="Demo sections">
      <span class="dr-store"><i></i>Kaveri Handlooms</span>
      ${[['overview', 'pulse', 'Overview'], ['publish', 'publish', 'Safe to publish'], ['products', 'catalog', 'Products'], ['reports', 'reports', 'Reports']].map(([k, ic, l], i) => `<button type="button" data-go="${k}" aria-current="${i === 0}">${icon(ic, 17)}<span>${l}</span></button>`).join('')}
    </nav>
    <div class="demo-main">${pane('overview', overview, true)}${pane('publish', publish)}${pane('products', products)}${pane('reports', reports)}</div>
  </div>
  <div class="demo-toast" data-toast hidden></div>
</div>`;

export const demoScript = `<script>
(function(){
  var d=document.querySelector('[data-demo]'); if(!d) return;
  var $=function(s,r){return (r||d).querySelector(s)}, $$=function(s,r){return [].slice.call((r||d).querySelectorAll(s))};
  var DAYS=${JSON.stringify(DAYS)}, COUNTS={day:[1,2,0],week:[1,4,0]};
  function toast(t){var el=$('[data-toast]');el.textContent=t;el.hidden=false;clearTimeout(el._t);el._t=setTimeout(function(){el.hidden=true},3200);}
  d.addEventListener('click',function(e){
    var go=e.target.closest('[data-go]');
    if(go){$$('[data-go]').forEach(function(b){b.setAttribute('aria-current',String(b===go))});$$('[data-dp]').forEach(function(p){p.hidden=p.dataset.dp!==go.dataset.go});return;}
    var is=e.target.closest('[data-issue]');
    if(is){var det=$('[data-detail="'+is.dataset.issue+'"]');var open=det.hidden;$$('[data-detail]').forEach(function(x){x.hidden=true});$$('[data-issue]').forEach(function(x){x.classList.remove('open')});det.hidden=!open;is.classList.toggle('open',open);return;}
    var run=e.target.closest('[data-run]');
    if(run){if(run.disabled)return;run.disabled=true;var box=$('[data-runbox]'),list=$('[data-list]');list.hidden=true;box.hidden=false;var steps=$$('li',box);steps.forEach(function(s){s.className=''});var i=0;
      (function next(){if(i>0)steps[i-1].className='done';if(i<steps.length){steps[i].className='now';i++;setTimeout(next,650);}else{setTimeout(function(){box.hidden=true;list.hidden=false;run.disabled=false;toast('Check finished: customers can buy. 1 thing still needs fixing.');},500);}})();return;}
    var b=e.target.closest('[data-seg] button');
    if(b){var seg=b.closest('[data-seg]');$$('button',seg).forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});var k=seg.dataset.seg,v=b.dataset.v;
      if(k==='view')$$('[data-view]').forEach(function(x){x.hidden=x.dataset.view!==v});
      if(k==='device')$('[data-stage]').className='dm-stage '+v;
      if(k==='filter')$$('tr[data-kind]').forEach(function(r){r.hidden=!(v==='all'||r.dataset.kind===v)});}
  });
  var sel=$('[data-compare]');
  if(sel)sel.addEventListener('change',function(){var v=sel.value,c=COUNTS[v];['new','fixed','still'].forEach(function(n,i){$('[data-n="'+n+'"]').textContent=c[i]});
    $$('[data-bars] i').forEach(function(bar,i){var x=DAYS[v][i];bar.style.setProperty('--h',x);bar.querySelector('span').textContent=x+'%';bar.title=bar.title.replace(/\\d+%$/,x+'%')});});
})();
</script>`;
