import fs from 'node:fs';
import path from 'node:path';
import { layout, esc, icon, badge } from './layout.js';
import { PRODUCTS, PLATFORMS, MARKETPLACES, CAPS, FAQ, STATUS } from './content.js';

const checkForm = (id = 'check') => `<form class="check-form" id="check-form" novalidate><label for="${id}-url" class="sr-only">Your store address</label>
  <input id="${id}-url" name="url" type="text" inputmode="url" autocomplete="url" placeholder="yourstore.com" required><button class="btn" type="submit">Run free check</button></form>
  <p class="error-msg" id="check-err" role="alert"></p>`;
const faq = (items) => `<section class="band"><div class="wrap narrow-w"><h2 class="h2">Questions</h2>${items.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>`;
const cta = (title = 'See how your store does in two minutes', sub = 'Free. No install, no login. Tests stop before payment.') => `<section class="cta-band"><div class="wrap"><div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div><div class="cta-actions"><a class="btn light" href="/#check">Run a free check</a><a class="btn ghost-light" href="/app#signup">Create free account</a></div></div></section>`;
const pageHead = ({ eyebrow, title, lede, actions = '', status }) => `<section class="page-hero"><div class="wrap">
  ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)} ${status ? badge(status) : ''}</p>` : ''}<h1>${esc(title)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ''}${actions ? `<div class="hero-actions">${actions}</div>` : ''}</div></section>`;

/* ---------- Product visual for the home hero ---------- */
const heroVisual = `<div class="mock" aria-label="Example Tharam dashboard">
  <div class="mock-top"><span class="dot g"></span><b>kaveri-handlooms.com</b><span class="mock-chip">Shopify</span></div>
  <div class="mock-kpis"><div><span>Buyability, 30 days</span><b>99.4%</b></div><div><span>Health</span><b>92</b></div><div><span>Next test</span><b>38 min</b></div></div>
  <ul class="mock-checks">
    <li><i class="ok">${icon('check', 13)}</i>Search returns products<em>0.9 s</em></li>
    <li><i class="ok">${icon('check', 13)}</i>Add to cart works<em>1.2 s</em></li>
    <li><i class="ok">${icon('check', 13)}</i>Checkout opens<em>2.1 s</em></li>
    <li><i class="warn">!</i>“Brass Diya Set” is priced at zero<em>Catalog</em></li>
    <li><i class="ok">${icon('check', 13)}</i>Pages look as approved<em>3 devices</em></li>
  </ul>
  <div class="mock-verdict"><span class="mv-ic">${icon('publish', 16)}</span><div><b>Safe to publish</b><span>“Diwali homepage” draft · nothing breaks</span></div><span class="st st-live">Draft vs live</span></div>
</div>`;

export function home() {
  const pillars = PRODUCTS.map((p) => `<a class="pillar" href="/features/${p.slug}"><span class="pl-ic">${icon(p.icon, 20)}</span><span class="pl-k">${esc(p.pillar)}</span><h3>${esc(p.name)} ${p.status !== 'live' ? badge(p.status) : ''}</h3><p>${esc(p.short)}</p><span class="more">Learn more ${icon('arrow', 14)}</span></a>`).join('');
  const body = `<main>
  <section class="hero2"><div class="wrap">
    <div class="h2-copy"><p class="eyebrow">The AI-powered Commerce Assurance platform</p>
      <h1>Make sure customers can always buy from you.</h1>
      <p class="lede">Tharam shops your store like a real customer around the clock, checks every theme change before it goes live, and uses AI to spot what only a person would notice. On Shopify, every major platform and, soon, the marketplaces you sell on.</p>
      <div id="check">${checkForm('hero')}</div>
      <p class="fine">Free check in about two minutes. No install or login. Tests stop before payment.</p></div>
    ${heroVisual}
  </div></section>

  <section class="band tight-top"><div class="wrap">
    <div class="verticals">
      <a class="vert" href="/platforms"><span class="vt-ic">${icon('store', 22)}</span><div><h3>Your own store</h3><p>Shopify today, with WooCommerce, BigCommerce, Adobe Commerce, Salesforce Commerce, Wix, Squarespace and headless stores at every level of support.</p><span class="more">Platforms ${icon('arrow', 14)}</span></div></a>
      <a class="vert" href="/marketplaces"><span class="vt-ic">${icon('market', 22)}</span><div><h3>Marketplaces ${badge('early')}</h3><p>Listing health and price and stock consistency on Amazon, Flipkart, Meesho and Myntra, side by side with your own store.</p><span class="more">Marketplaces ${icon('arrow', 14)}</span></div></a>
      <a class="vert" href="/demo"><span class="vt-ic">${icon('agency', 22)}</span><div><h3>Agencies and larger brands</h3><p>Many stores in one place, reports you can hand to clients, and journeys set up for your storefronts.</p><span class="more">Book a demo ${icon('arrow', 14)}</span></div></a>
    </div>
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">What Commerce Assurance covers</p><h2 class="h2">Five ways a store quietly stops selling. One platform watching all of them.</h2></div>
    <div class="pillars">${pillars}</div>
  </div></section>

  <section class="band"><div class="wrap split">
    <div><p class="eyebrow">The standard metric</p><h2 class="h2">Buyability: the share of time customers could actually buy.</h2>
      <p class="body-l">Uptime tells you the homepage loaded. Buyability tells you a customer could find a product, add it to the cart and reach checkout. Tharam measures it every few hours and shows it over a day, a week and a month, so you know exactly what your store delivered.</p>
      <a class="link-arrow" href="/commerce-assurance">Why Buyability matters ${icon('arrow', 15)}</a></div>
    <div class="metric-card"><div class="mc-row"><span>Last 24 hours</span><b>100%</b></div><div class="mc-row"><span>Last 7 days</span><b>99.4%</b></div><div class="mc-row warn"><span>Last 30 days</span><b>97.8%</b></div>
      <div class="mc-bars">${Array.from({ length: 42 }, (_, i) => `<i class="${i === 17 || i === 18 ? 'bad' : i === 30 ? 'meh' : ''}"></i>`).join('')}</div><p class="mc-note">Add to cart broke for 6 hours on 12 Oct after a cart-drawer app update. Fixed the same day.</p></div>
  </div></section>

  <section class="band"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">AI-powered</p><h2 class="h2">AI that sees your store the way customers do</h2>
      <p class="body-l">Our checks are deterministic, so an alert is always real. On top of them, AI looks at your pages and reads your product copy like a shopper, catching what rules can’t.</p></div>
    <div class="ai-grid">
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>AI visual review ${badge('beta')}</h3><p>Every page on desktop and phone, checked for overlapping text, cut-off prices, broken images and popups covering the buy button.</p></div>
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>AI copy review ${badge('beta')}</h3><p>Spelling, grammar and contradictions in new or edited products, like a silk saree described as cotton.</p></div>
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>Explain this change ${badge('beta')}</h3><p>Two screenshots differ: AI says what changed and whether it looks intended or like a bug.</p></div>
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>AI shopper agents ${badge('soon')}</h3><p>Shoppers with a goal, like “find a gift under ₹2,000 and check out”, that report where they struggled, on any theme.</p></div>
    </div>
  </div></section>

  <section class="band white"><div class="wrap split rev">
    <div class="publish-demo"><div class="pd-head"><span class="st st-bad">Don’t publish yet</span><b>Black Friday theme</b></div>
      <div class="pd-scores"><div><span>Live</span><b>98</b></div>${icon('arrow', 18)}<div><span>Draft</span><b class="bad">46</b></div></div>
      <ul><li><span class="sev-b">Breaks</span>Add to cart on mobile does nothing</li><li><span class="sev-w">Check</span>Homepage loads 1.2 s slower</li><li><span class="sev-g">Fixed</span>Broken “Sale” link in the menu</li></ul></div>
    <div><p class="eyebrow">Only on Tharam</p><h2 class="h2">Know a theme change is safe before you publish it.</h2>
      <p class="body-l">Paste a theme preview link. Tharam tests the draft and your live store side by side, on desktop, tablet and phone, and tells you what would break, what it fixes, and how it changes speed and the look of every page.</p>
      <a class="link-arrow" href="/features/safe-to-publish">How Safe to publish works ${icon('arrow', 15)}</a></div>
  </div></section>

  <section class="band"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">How it works</p><h2 class="h2">Set up in two minutes. Protected around the clock.</h2></div>
    <ol class="steps3"><li><h3>Add your store</h3><p>Tharam reads your products and collections and builds a test suite for your store. Nothing to code.</p></li>
      <li><h3>Choose what to watch</h3><p>Pick the journeys, checks and schedule. Run validations any time and see the plan before anything starts.</p></li>
      <li><h3>Hear only when it matters</h3><p>Failures are re-tested before you are alerted, by email or Slack, with screenshots and how to fix it.</p></li></ol>
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head"><h2 class="h2">Why “the site is up” isn’t enough</h2><p class="body-l">An uptime monitor sees your homepage load. It can’t see that an app update stopped Add to cart working at 2 am.</p></div>
    <div class="table-scroll"><table class="cmp"><thead><tr><th></th><th>Checking by hand</th><th>Uptime monitor</th><th class="us">Tharam</th></tr></thead><tbody>
      ${[['Store is online', 'Sometimes', '✓', '✓'], ['Add to cart and checkout actually work', 'When you remember', '–', '✓'], ['Draft themes tested before publishing', '–', '–', '✓'], ['Every product checked for pricing mistakes', '–', '–', '✓'], ['Speed, SEO and accessibility on every device', '–', '–', '✓'], ['Failures confirmed before alerting', '–', '–', '✓']]
        .map((r) => `<tr><td>${esc(r[0])}</td><td class="${r[1] === '✓' ? 'yes' : 'no'}">${esc(r[1])}</td><td class="${r[2] === '✓' ? 'yes' : 'no'}">${esc(r[2])}</td><td class="us yes">${esc(r[3])}</td></tr>`).join('')}
    </tbody></table></div>
  </div></section>
  ${faq(FAQ)}
  ${cta()}
  </main>`;
  return layout({ title: '', description: 'Tharam is the AI-powered Commerce Assurance platform: it shops your store like a real customer around the clock, checks theme changes before you publish, and watches your catalog for mistakes. Shopify, every major platform and marketplaces.', path: '/', body });
}

export function category() {
  const body = `<main>${pageHead({ eyebrow: 'The category', title: 'Commerce Assurance', lede: 'Continuous proof that customers can find, trust and buy from you, on your own store and every marketplace you sell on.', actions: `<a class="btn" href="/#check">Run a free check</a><a class="btn secondary" href="/pricing">See pricing</a>` })}
  <section class="band white"><div class="wrap split">
    <div><h2 class="h2">Stores don’t go down. They quietly stop selling.</h2>
      <p class="body-l">Online stores change every day: theme edits, app updates, price imports, new products, sale banners. Most failures don’t take the site offline. They break one button, one price, one page on one device, and the store keeps looking fine to everyone except the customer trying to buy.</p>
      <p class="body-l">Uptime monitoring was built for websites. QA testing was built for software teams. Neither was built for a merchant whose revenue depends on every product, price and checkout working, every hour.</p></div>
    <div class="quote-card"><p>Commerce Assurance answers one question continuously: <b>can customers buy from me right now, and will they still be able to after this change?</b></p></div>
  </div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><p class="eyebrow">The five pillars</p><h2 class="h2">What a Commerce Assurance platform covers</h2></div>
    <div class="pillars">${PRODUCTS.map((p) => `<a class="pillar" href="/features/${p.slug}"><span class="pl-ic">${icon(p.icon, 20)}</span><span class="pl-k">${esc(p.pillar)}</span><h3>${esc(p.name)}</h3><p>${esc(p.short)}</p></a>`).join('')}</div></div></section>
  <section class="band white"><div class="wrap split">
    <div><p class="eyebrow">The standard metric</p><h2 class="h2">Buyability</h2>
      <p class="body-l"><b>Buyability is the share of tests in which a customer could complete a purchase</b>: find a product, add it to the cart and reach checkout, on desktop and phone.</p>
      <p class="body-l">It replaces uptime as the number that matters for a store. A store can have 100% uptime and 90% Buyability, which means one customer in ten couldn’t buy for some part of the month.</p></div>
    <div class="formula"><span>Buyability</span><b>=</b><div><span>tests where checkout could be reached</span><i></i><span>all journey tests</span></div></div>
  </div></section>
  ${cta('Measure your store’s Buyability', 'Start with a free check. Monitoring starts when you create an account.')}</main>`;
  return layout({ title: 'Commerce Assurance', description: 'Commerce Assurance is continuous proof that customers can find, trust and buy from you. Learn the five pillars and the Buyability metric.', path: '/commerce-assurance', body });
}

export function productIndex() {
  const body = `<main>${pageHead({ eyebrow: 'Features', title: 'Everything that keeps a store selling, in one platform', lede: 'Journey monitoring, Safe to publish, catalog guard, experience checks, AI review and reports, all built around one question: can customers buy?' })}
    <section class="band white"><div class="wrap"><div class="pillars">${PRODUCTS.map((p) => `<a class="pillar" href="/features/${p.slug}"><span class="pl-ic">${icon(p.icon, 20)}</span><span class="pl-k">${esc(p.pillar)}</span><h3>${esc(p.name)} ${p.status !== 'live' ? badge(p.status) : ''}</h3><p>${esc(p.short)}</p><span class="more">Learn more ${icon('arrow', 14)}</span></a>`).join('')}</div></div></section>${cta()}</main>`;
  return layout({ title: 'Features', description: 'The Tharam platform: journey monitoring, Safe to publish, catalog guard, experience checks, AI review and reports.', path: '/features', body });
}

export function product(slug) {
  const p = PRODUCTS.find((x) => x.slug === slug);
  if (!p) return null;
  const others = PRODUCTS.filter((x) => x.slug !== slug).slice(0, 3);
  const support = PLATFORMS.map((pl) => { const k = { monitoring: 'journey', 'safe-to-publish': 'publish', catalog: 'catalog', experience: 'experience', ai: 'experience', reports: 'experience' }[slug]; return [pl, pl.caps[k]]; });
  const body = `<main>${pageHead({ eyebrow: `Feature · ${p.pillar}`, status: p.status, title: p.title, lede: p.lede, actions: `<a class="btn" href="/app#signup">Start free</a><a class="btn secondary" href="/#check">Run a free check</a>` })}
  <div class="plan-note"><div class="wrap">${p.name} is part of the Tharam platform, not a separate product. <a href="/pricing">See what each plan includes</a>.</div></div>
  <section class="band white"><div class="wrap"><div class="features">${p.points.map(([t, d]) => `<div class="feature"><span class="ft-ic">${icon('check', 16)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><h2 class="h2">Where it works</h2></div>
    <div class="support-grid">${support.map(([pl, st]) => `<a href="/platforms/${pl.slug}" class="sup"><span>${esc(pl.name)}</span>${badge(st)}</a>`).join('')}</div></div></section>
  <section class="band white"><div class="wrap"><div class="sec-head"><h2 class="h2">Also in Tharam</h2></div><div class="pillars three">${others.map((o) => `<a class="pillar" href="/features/${o.slug}"><span class="pl-ic">${icon(o.icon, 20)}</span><h3>${esc(o.name)}</h3><p>${esc(o.short)}</p></a>`).join('')}</div></div></section>
  ${cta()}</main>`;
  return layout({ title: p.name, description: p.short, path: `/features/${slug}`, body });
}

const capTable = (list) => `<div class="table-scroll"><table class="cmp caps"><thead><tr><th>Capability</th>${list.map((p) => `<th><a href="/platforms/${p.slug}">${esc(p.name)}</a></th>`).join('')}</tr></thead><tbody>
  ${CAPS.map(([k, l]) => `<tr><td>${esc(l)}</td>${list.map((p) => `<td>${badge(p.caps[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export function platformIndex() {
  const body = `<main>${pageHead({ eyebrow: 'Platforms', title: 'Commerce Assurance for every store platform', lede: 'Experience checks work on any storefront today. Shopping-journey monitoring, catalog guard and Safe to publish are built platform by platform, starting with Shopify.' })}
    <section class="band white"><div class="wrap"><div class="plat-grid">${PLATFORMS.map((p) => `<a class="plat" href="/platforms/${p.slug}"><div class="plat-h"><h3>${esc(p.name)}</h3>${badge(p.status)}</div><p>${esc(p.blurb)}</p><span class="more">Details ${icon('arrow', 14)}</span></a>`).join('')}</div></div></section>
    <section class="band"><div class="wrap"><div class="sec-head"><h2 class="h2">What works where</h2></div>${capTable(PLATFORMS)}</div></section>${cta()}</main>`;
  return layout({ title: 'Platforms', description: 'Tharam on Shopify, WooCommerce, BigCommerce, Adobe Commerce, Salesforce Commerce Cloud, Wix, Squarespace and headless stores.', path: '/platforms', body });
}

export function platform(slug) {
  const p = PLATFORMS.find((x) => x.slug === slug);
  if (!p) return null;
  const live = p.status === 'live';
  const body = `<main>${pageHead({ eyebrow: 'Platforms', status: p.status, title: `Tharam for ${p.name}`, lede: p.blurb, actions: `<a class="btn" href="/#check">Check my ${esc(p.name.split(' ')[0])} store</a>${live ? '<a class="btn secondary" href="/app#signup">Start free</a>' : '<a class="btn secondary" href="/demo">Talk to us</a>'}` })}
  <section class="band white"><div class="wrap split">
    <div><h2 class="h2">What Tharam does on ${esc(p.name)}</h2><ul class="cap-list">${CAPS.map(([k, l]) => `<li><span>${esc(l)}</span>${badge(p.caps[k])}</li>`).join('')}</ul></div>
    <div>${p.notes.length ? `<div class="note-card"><h3>Good to know</h3><ul>${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      ${!live ? `<form class="note-card wl" data-waitlist="platform-${esc(p.slug)}" novalidate><h3>Get ${esc(p.name)} journey tests first</h3><p>Leave your email and store address. We’ll set you up as soon as they’re ready.</p>
        <input name="email" type="email" placeholder="you@yourstore.com" required aria-label="Email"><input name="url" type="text" placeholder="yourstore.com" aria-label="Store address"><button class="btn" type="submit">Join early access</button><p class="wl-msg" role="status"></p></form>` : ''}</div>
  </div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><h2 class="h2">The platform</h2></div><div class="pillars three">${PRODUCTS.slice(0, 3).map((o) => `<a class="pillar" href="/features/${o.slug}"><span class="pl-ic">${icon(o.icon, 20)}</span><h3>${esc(o.name)}</h3><p>${esc(o.short)}</p></a>`).join('')}</div></div></section>
  ${cta(`See how your ${p.name.split(' ')[0]} store does`)}</main>`;
  return layout({ title: `Tharam for ${p.name}`, description: p.blurb, path: `/platforms/${slug}`, body });
}

export function marketIndex() {
  const body = `<main>${pageHead({ eyebrow: 'Marketplaces', status: 'early', title: 'Your listings, guarded like your own store', lede: 'Brands sell on their own store and on marketplaces. Tharam will watch both: listing health on each marketplace, and prices, stock and content kept consistent with your own store.' })}
    <section class="band white"><div class="wrap"><div class="plat-grid">${MARKETPLACES.map((m) => `<a class="plat" href="/marketplaces/${m.slug}"><div class="plat-h"><h3>${esc(m.name)}</h3>${badge(m.status)}</div><p>${esc(m.blurb)}</p><span class="more">Details ${icon('arrow', 14)}</span></a>`).join('')}</div></div></section>
    <section class="band"><div class="wrap split"><div><p class="eyebrow">Only on Tharam</p><h2 class="h2">One catalog, checked everywhere you sell</h2><p class="body-l">The same product priced differently on two channels, in stock on your store but inactive on a marketplace, or edited on one channel only. Tharam already fingerprints every product in your store; marketplace guard compares those fingerprints across every channel.</p></div>
      <form class="note-card wl" data-waitlist="marketplaces" novalidate><h3>Join early access</h3><p>Tell us where you sell. We’ll invite brands in the order they join.</p><input name="email" type="email" placeholder="you@brand.com" required aria-label="Email"><input name="url" type="text" placeholder="Your store and marketplaces" aria-label="Where you sell"><button class="btn" type="submit">Join early access</button><p class="wl-msg" role="status"></p></form></div></section>
    ${cta()}</main>`;
  return layout({ title: 'Marketplaces', description: 'Listing health and cross-channel catalog consistency for brands selling on Amazon, Flipkart, Meesho and Myntra.', path: '/marketplaces', body });
}

export function market(slug) {
  const m = MARKETPLACES.find((x) => x.slug === slug);
  if (!m) return null;
  const body = `<main>${pageHead({ eyebrow: 'Marketplaces', status: m.status, title: `Tharam for ${m.name} sellers`, lede: m.blurb })}
  <section class="band white"><div class="wrap split">
    <div><h2 class="h2">What Tharam will watch</h2><ul class="tick-list">${m.watch.map((w) => `<li>${icon('check', 16)}<span>${esc(w)}</span></li>`).join('')}</ul><p class="muted">Connected through ${esc(m.via)}</p></div>
    <form class="note-card wl" data-waitlist="marketplace-${esc(m.slug)}" novalidate><h3>Join ${esc(m.name)} early access</h3><p>We’re inviting brands that sell on ${esc(m.name)} and their own store first.</p>
      <input name="email" type="email" placeholder="you@brand.com" required aria-label="Email"><input name="url" type="text" placeholder="Your store or brand" aria-label="Store or brand"><button class="btn" type="submit">Join early access</button><p class="wl-msg" role="status"></p></form>
  </div></section>${cta('Start with your own store today')}</main>`;
  return layout({ title: `Tharam for ${m.name}`, description: m.blurb, path: `/marketplaces/${slug}`, body });
}

export function pricing() {
  const plan = (name, price, per, items, btn, hl) => `<div class="plan ${hl ? 'hl' : ''}">${hl ? '<span class="plan-tag">Most popular</span>' : ''}<h3>${esc(name)}</h3><div class="price"><b>${esc(price)}</b><span>${esc(per)}</span></div><ul>${items.map((i) => `<li>${icon('check', 15)}<span>${esc(i)}</span></li>`).join('')}</ul>${btn}</div>`;
  const body = `<main>${pageHead({ eyebrow: 'Pricing', title: 'Free during the beta', lede: 'Every feature is free while Tharam is in beta. We’ll give at least 30 days’ notice before any charge, and beta users keep a founding discount.' })}
  <section class="band white"><div class="wrap"><div class="plans">
    ${plan('Beta', 'Free', 'today', ['Up to 5 stores', 'Journey tests as often as hourly', 'Daily full check with visual changes', 'Safe to publish and catalog guard', 'Email and Slack alerts'], '<a class="btn block" href="/app#signup">Create free account</a>', true)}
    ${plan('Starter', '$19', 'per store / month after beta', ['Daily journey tests', 'Experience checks', 'Email alerts'], '<span class="plan-later">After the beta</span>')}
    ${plan('Growth', '$49', 'per store / month after beta', ['Hourly journey tests', 'Safe to publish', 'Catalog guard and visual changes', 'Slack alerts'], '<span class="plan-later">After the beta</span>')}
    ${plan('Pro', '$99', 'per store / month after beta', ['Tests every 15 minutes', 'AI review', 'Priority support'], '<span class="plan-later">After the beta</span>')}
  </div><p class="muted center">Agencies and brands with many stores: <a href="/demo">talk to us</a>. Marketplace guard is in early access.</p></div></section>
  ${faq(FAQ.slice(0, 3))}</main>`;
  return layout({ title: 'Pricing', description: 'Tharam is free during the beta. Planned plans after the beta, per store.', path: '/pricing', body });
}

/** Puts an existing static page (its <main> and scripts) into the site layout. */
export function legacy(publicDir, file, { title, path: p, noindex = false } = {}) {
  const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
  const start = html.indexOf('<main'), end = html.indexOf('</main>');
  if (start < 0 || end < 0) return html;
  const main = html.slice(start, end + 7);
  const scripts = (html.slice(end).match(/<script[\s\S]*?<\/script>/g) || []).join('\n');
  const t = title ?? (/<title>([^<]*)<\/title>/.exec(html)?.[1] || '').replace(/\s*[–-]\s*Tharam.*$/, '');
  const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] || '';
  const styles = (html.slice(0, start).match(/<style[\s\S]*?<\/style>/g) || []).join('');
  return layout({ title: t, description: desc, path: p, body: `<div class="legacy">${main}</div>`, noindex, scripts, extraHead: styles });
}
