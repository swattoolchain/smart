import fs from 'node:fs';
import path from 'node:path';
import { layout, esc, icon, badge, capCell, VERSION } from './layout.js';
export { VERSION };
import { PRODUCTS, PLATFORMS, MARKETPLACES, CAPS, FAQ, MANAGED, AUDIENCES, PROMISES } from './content.js';
import { demoMarkup, demoScript } from './demo.js';

const checkForm = (id = 'check') => `<form class="check-form" id="check-form" novalidate><label for="${id}-url" class="sr-only">Your store address</label>
  <input id="${id}-url" name="url" type="text" inputmode="url" autocomplete="url" placeholder="yourstore.com" required><button class="btn" type="submit">Check my store free</button></form>
  <p class="error-msg" id="check-err" role="alert"></p>`;
const faq = (items) => `<section class="band"><div class="wrap faq-wrap"><div><p class="eyebrow">Questions</p><h2 class="h2">Answers in plain words</h2><p class="body-l">Something else on your mind? <a href="mailto:hello@tharam.store">Email us</a> or <a href="/demo">book a call</a>.</p></div>
  <div>${items.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></div></section>`;
const cta = (title = 'See how your store is doing, free', sub = 'Takes about two minutes. Nothing to install, no account needed, no orders placed.') => `<section class="cta-band"><div class="wrap"><div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div><div class="cta-actions"><a class="btn light" href="/#check">Check my store free</a><a class="btn ghost-light" href="/managed">Have us look after it</a></div></div></section>`;
const pageHead = ({ eyebrow, title, lede, actions = '', status }) => `<section class="page-hero"><div class="wrap">
  ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)} ${status ? badge(status) : ''}</p>` : ''}<h1>${esc(title)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ''}${actions ? `<div class="hero-actions">${actions}</div>` : ''}</div></section>`;
const featureCard = (p, more = true) => `<a class="pillar" href="/features/${p.slug}"><span class="pl-ic">${icon(p.icon, 20)}</span><span class="pl-k">${esc(p.pillar)}</span><h3>${esc(p.name)} ${p.status !== 'live' ? badge(p.status) : ''}</h3><p>${esc(p.short)}</p>${more ? `<span class="more">Learn more ${icon('arrow', 14)}</span>` : ''}</a>`;

/* ---------- Home ---------- */
const heroVisual = `<div class="mock" aria-label="Example of the Tharam dashboard">
  <div class="mock-top"><span class="dot g"></span><b>kaveri-handlooms.com</b><span class="mock-chip">Checked 4 min ago</span></div>
  <div class="mock-kpis"><div><span>Customers could buy</span><b>99.4%</b></div><div><span>Store health</span><b>92</b></div><div><span>Next check</span><b>38 min</b></div></div>
  <ul class="mock-checks">
    <li><i class="ok">${icon('check', 13)}</i>Search finds products</li>
    <li><i class="ok">${icon('check', 13)}</i>Add to cart works</li>
    <li><i class="ok">${icon('check', 13)}</i>Checkout opens</li>
    <li><i class="warn">!</i>“Brass Diya Set” is priced at ₹0<em>Fix now</em></li>
    <li><i class="ok">${icon('check', 13)}</i>Phone pages load fast</li>
  </ul>
  <div class="mock-verdict"><span class="mv-ic">${icon('check', 16)}</span><div><b>Safe to publish</b><span>Your new Diwali homepage won’t break anything</span></div></div>
</div>`;

export function home() {
  const body = `<main>
  <section class="hero2"><div class="wrap">
    <div class="h2-copy"><p class="eyebrow">AI-powered store checks for online sellers</p>
      <h1>Make sure customers can always buy from you.</h1>
      <p class="lede">A broken Add to cart button, a wrong price, a slow page: small problems that quietly cost you sales. Tharam checks your online store every few hours, like a real customer, and tells you the moment something stops working.</p>
      <div id="check">${checkForm('hero')}</div>
      <p class="fine">Free. Takes about two minutes. No install, no account, no orders placed.</p></div>
    ${heroVisual}
  </div></section>
  <div class="promises"><div class="wrap">${PROMISES.map(([ic, t]) => `<span>${icon(ic, 17)}${esc(t)}</span>`).join('')}</div></div>

  <section class="band white"><div class="wrap">
    <div class="sec-head center-h"><p class="eyebrow">Why it matters</p><h2 class="h2">Your store can look fine and still not sell</h2>
      <p class="body-l">Apps update, themes change, prices get imported. Most problems don’t take your store offline. They break one button or one price, and you only find out when sales drop.</p></div>
    <div class="problems">
      <div><b>“Add to cart stopped working after an app update.”</b><span>Found by Tharam within hours, not when a customer complained.</span></div>
      <div><b>“A product went live at ₹0 after a price import.”</b><span>Flagged on the next check, before anyone ordered it free.</span></div>
      <div><b>“The new sale banner covered the Buy button on phones.”</b><span>Caught before publishing, with Safe to publish.</span></div>
    </div>
  </div></section>

  <section class="band"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">What Tharam does</p><h2 class="h2">Everything a careful shop manager would check, every few hours</h2></div>
    <div class="pillars">${PRODUCTS.map((p) => featureCard(p)).join('')}</div>
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head center-h"><p class="eyebrow">Try it</p><h2 class="h2">Click around a sample store</h2><p class="body-l">This is what you see after Tharam checks your store. Open an issue, run a check, or try Safe to publish.</p></div>
    ${demoMarkup}
  </div></section>

  <section class="band"><div class="wrap split">
    <div><p class="eyebrow">Your store score</p><h2 class="h2">One number: how often customers could actually buy</h2>
      <p class="body-l">We call it Buyability. “The website was up” only means the homepage opened. Buyability means a customer could find a product, add it to the cart and reach checkout. You see it for today, this week and this month.</p>
      <a class="link-arrow" href="/commerce-assurance">Why Tharam ${icon('arrow', 15)}</a></div>
    <div class="metric-card"><div class="mc-row"><span>Today</span><b>100%</b></div><div class="mc-row"><span>This week</span><b>99.4%</b></div><div class="mc-row warn"><span>This month</span><b>97.8%</b></div>
      <div class="mc-bars">${Array.from({ length: 42 }, (_, i) => `<i class="${i === 17 || i === 18 ? 'bad' : i === 30 ? 'meh' : ''}"></i>`).join('')}</div><p class="mc-note">12 Oct: Add to cart stopped working for 6 hours after an app update. Fixed the same day.</p></div>
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">AI-powered</p><h2 class="h2">An extra pair of eyes that never gets tired</h2>
      <p class="body-l">Our checks give you a clear yes or no, so an alert is always real. On top of that, AI looks at your pages and reads your product text like a shopper would.</p></div>
    <div class="ai-grid">
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>Looks at every page</h3><p>Text covering photos, cut-off prices, broken images, or a popup hiding the Buy button, on computer and phone.</p></div>
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>Reads your product text</h3><p>Spelling mistakes and mix-ups, like a silk saree described as cotton, with a suggested fix.</p></div>
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>Explains what changed</h3><p>A page looks different? AI tells you what changed and whether it looks deliberate or like a mistake.</p></div>
      <div class="ai-card"><span class="ai-ic">${icon('sparkle', 18)}</span><h3>AI shoppers ${badge('early')}</h3><p>Shoppers with a goal, like “find a gift under ₹2,000”, that tell you where they got stuck.</p></div>
    </div>
  </div></section>

  <section class="band"><div class="wrap split rev">
    <div class="publish-demo"><div class="pd-head"><span class="st st-bad">Don’t publish yet</span><b>Black Friday design</b></div>
      <div class="pd-scores"><div><span>Current store</span><b>98</b></div>${icon('arrow', 18)}<div><span>New design</span><b class="bad">46</b></div></div>
      <ul><li><span class="sev-b">Breaks</span>Add to cart on phones does nothing</li><li><span class="sev-w">Slower</span>Homepage takes 1.2 seconds longer</li><li><span class="sev-g">Fixed</span>Broken “Sale” link in the menu</li></ul></div>
    <div><p class="eyebrow">Only on Tharam</p><h2 class="h2">Change your store design without the fear</h2>
      <p class="body-l">Before you publish a new design or sale banner, Tharam tests it next to your current store and tells you plainly: safe to publish, have a look first, or don’t publish yet.</p>
      <a class="link-arrow" href="/features/safe-to-publish">How Safe to publish works ${icon('arrow', 15)}</a></div>
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Who it’s for</p><h2 class="h2">Built for everyone who depends on a store that sells</h2></div>
    <div class="audiences">${AUDIENCES.map(([ic, t, d]) => `<div class="aud"><span class="aud-ic">${icon(ic, 20)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
    <div class="verticals">
      <a class="vert" href="/platforms"><span class="vt-ic">${icon('store', 22)}</span><div><h3>Any online store</h3><p>Shopify today, plus WooCommerce, BigCommerce, Magento, Wix, Squarespace and custom-built stores.</p><span class="more">See platforms ${icon('arrow', 14)}</span></div></a>
      <a class="vert" href="/marketplaces"><span class="vt-ic">${icon('market', 22)}</span><div><h3>Marketplaces ${badge('early')}</h3><p>Selling on Amazon, Flipkart, Meesho or Myntra too? Keep listings, prices and stock right everywhere.</p><span class="more">See marketplaces ${icon('arrow', 14)}</span></div></a>
      <a class="vert" href="/managed"><span class="vt-ic">${icon('tool', 22)}</span><div><h3>Done for you</h3><p>Rather not deal with it? Our team watches your store, fixes what breaks and checks every change.</p><span class="more">Managed service ${icon('arrow', 14)}</span></div></a>
    </div>
  </div></section>

  <section class="band"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">How it works</p><h2 class="h2">Up and running in two minutes</h2></div>
    <ol class="steps3"><li><h3>Enter your store address</h3><p>Tharam finds your products and sets up the right checks for your store. No code, nothing to install.</p></li>
      <li><h3>Choose how often</h3><p>Every hour, every few hours or once a day. You can also run a check whenever you like.</p></li>
      <li><h3>Hear only when it matters</h3><p>An email or Slack message when something breaks, with a picture of the problem and how to fix it.</p></li></ol>
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head"><h2 class="h2">More than “is my website up?”</h2><p class="body-l">A website monitor only checks that your homepage opens. It can’t tell that customers stopped being able to pay.</p></div>
    <div class="table-scroll"><table class="cmp"><thead><tr><th></th><th>Checking it yourself</th><th>Website monitor</th><th class="us">Tharam</th></tr></thead><tbody>
      ${[['Store is online', 'Sometimes', '✓'], ['Add to cart and checkout actually work', 'When you remember', '–'], ['New designs tested before publishing', '–', '–'], ['Every product checked for price mistakes', '–', '–'], ['Fast on phones and easy to find on Google', '–', '–'], ['Problems double-checked before alerting you', '–', '–']]
        .map((r) => `<tr><td>${esc(r[0])}</td><td class="no">${esc(r[1])}</td><td class="${r[2] === '✓' ? 'yes' : 'no'}">${esc(r[2])}</td><td class="us yes">✓</td></tr>`).join('')}
    </tbody></table></div>
  </div></section>
  ${faq(FAQ)}
  ${cta()}
  </main>`;
  return layout({ scripts: demoScript, title: '', description: 'Tharam checks your online store every few hours like a real customer and tells you the moment customers can’t buy. Product and price checks, tests for design changes, and AI that looks at your pages like a shopper. Free during the beta.', path: '/', body });
}

/* ---------- Why Tharam (the category page) ---------- */
export function category() {
  const body = `<main>${pageHead({ eyebrow: 'Why Tharam', title: 'Your store can be open and still not sell', lede: 'We started Tharam because online stores rarely break loudly. They break quietly, one button, one price or one page at a time, and the owner finds out last.', actions: `<a class="btn" href="/#check">Check my store free</a><a class="btn secondary" href="/managed">Have us look after it</a>` })}
  <section class="band white"><div class="wrap split">
    <div><h2 class="h2">Small problems, real money</h2>
      <p class="body-l">Every week something on your store changes: an app updates itself, someone edits the theme, prices are imported, a sale banner goes live. Any of these can stop customers from buying, often on phones only, and your store still looks fine to you.</p>
      <p class="body-l">Website monitors only check that the homepage opens. Developers test their own code, not your whole store. Nobody checks the whole shopping trip, every few hours, for you. That’s what Tharam does.</p></div>
    <div class="quote-card"><p>Tharam answers one question, all the time: <b>can customers buy from me right now, and will they still be able to after this change?</b></p></div>
  </div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><p class="eyebrow">What Tharam checks</p><h2 class="h2">Six questions, answered for you every few hours</h2></div>
    <div class="pillars">${PRODUCTS.map((p) => featureCard(p, false)).join('')}</div></div></section>
  <section class="band white"><div class="wrap split">
    <div><p class="eyebrow">Your store score</p><h2 class="h2">Buyability</h2>
      <p class="body-l"><b>Buyability is how often customers could actually buy from you</b>: find a product, add it to the cart and reach checkout, on a computer and on a phone.</p>
      <p class="body-l">A store can be “up” all month and still have customers unable to buy for days. Buyability shows you the real picture, and it’s the number we work to keep at 100%.</p></div>
    <div class="formula"><span>Buyability</span><b>=</b><div><span>checks where a customer could reach checkout</span><i></i><span>all shopping checks</span></div></div>
  </div></section>
  <section class="band"><div class="wrap narrow-w center"><p class="eyebrow center-e">Our name</p><h2 class="h2 center-h2">We call this Commerce Assurance</h2><p class="body-l center-p">Continuous proof that customers can find, trust and buy from you, on your own store and wherever else you sell. Tharam is built to be the simplest way to get it.</p></div></section>
  ${cta()}</main>`;
  return layout({ title: 'Why Tharam', description: 'Online stores rarely break loudly. Tharam checks your whole store every few hours, like a customer, so you find out first.', path: '/commerce-assurance', body });
}

/* ---------- Managed service ---------- */
export function managed() {
  const body = `<main>${pageHead({ eyebrow: 'Managed service', title: 'We look after your store, so you don’t have to', lede: 'Not technical, or simply too busy? Our team watches your store every day, fixes what breaks, checks every change before it goes live, and keeps your products and prices right. You run the business. We keep the store selling.', actions: `<a class="btn" href="#enquire">Get a free store review</a><a class="btn secondary" href="/demo">Book a call</a>` })}
  <section class="band white"><div class="wrap"><div class="sec-head"><p class="eyebrow">What we do for you</p><h2 class="h2">Everything Tharam does, plus a team that acts on it</h2></div>
    <div class="features three-col">${MANAGED.points.map(([ic, t, d]) => `<div class="feature"><span class="ft-ic blue">${icon(ic, 17)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><p class="eyebrow">How it works</p><h2 class="h2">Three steps, no technical work for you</h2></div>
    <ol class="steps3">${MANAGED.steps.map(([t, d]) => `<li><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol></div></section>
  <section class="band white" id="enquire"><div class="wrap split">
    <div><p class="eyebrow">Start with a free store review</p><h2 class="h2">Tell us about your store</h2>
      <p class="body-l">We’ll check your store, send you what we find, and suggest the right level of care. Pricing depends on your store’s size and how much you’d like us to handle; there’s no commitment until you decide.</p>
      <ul class="tick-list"><li>${icon('check', 16)}<span>You stay in control: we only work through access you give, and you can remove it at any time.</span></li><li>${icon('check', 16)}<span>We never publish changes without your approval.</span></li><li>${icon('check', 16)}<span>A real person you can call or message.</span></li></ul></div>
    <form class="note-card wl" data-waitlist="managed-service" novalidate><h3>Request a free store review</h3><p>We usually reply within one working day.</p>
      <input name="email" type="email" placeholder="you@yourstore.com" required aria-label="Your email"><input name="url" type="text" placeholder="Your store address" aria-label="Your store address"><button class="btn" type="submit">Request my free review</button><p class="wl-msg" role="status"></p></form>
  </div></section>
  ${faq(FAQ.filter((f) => /technical|fake|managed|look after/i.test(f[0])))}</main>`;
  return layout({ title: 'Managed service', description: 'Our team watches your online store every day, fixes what breaks, checks every change and keeps products and prices right. Start with a free store review.', path: '/managed', body });
}

/* ---------- Features ---------- */
export function productIndex() {
  const body = `<main>${pageHead({ eyebrow: 'Features', title: 'Everything that keeps your store selling', lede: 'One service, six things it does for you. All of them are included in your Tharam plan.' })}
    <section class="band white"><div class="wrap"><div class="pillars">${PRODUCTS.map((p) => featureCard(p)).join('')}</div></div></section>${cta()}</main>`;
  return layout({ title: 'Features', description: 'Store checks around the clock, Safe to publish, product and price checks, speed and Google checks, AI review and reports.', path: '/features', body });
}

export function product(slug) {
  const p = PRODUCTS.find((x) => x.slug === slug);
  if (!p) return null;
  const others = PRODUCTS.filter((x) => x.slug !== slug).slice(0, 3);
  const k = { monitoring: 'journey', 'safe-to-publish': 'publish', catalog: 'catalog', experience: 'experience', ai: 'experience', reports: 'experience' }[slug];
  const body = `<main>${pageHead({ eyebrow: p.pillar, status: p.status, title: p.title, lede: p.lede, actions: `<a class="btn" href="/#check">Check my store free</a><a class="btn secondary" href="/app#signup">Create free account</a>` })}
  <div class="plan-note"><div class="wrap">${esc(p.name)} is included in every Tharam plan. <a href="/pricing">See plans</a></div></div>
  <section class="band white"><div class="wrap"><div class="features">${p.points.map(([t, d]) => `<div class="feature"><span class="ft-ic">${icon('check', 16)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><h2 class="h2">Works with</h2></div>
    <div class="support-grid">${PLATFORMS.map((pl) => `<a href="/platforms/${pl.slug}" class="sup"><span>${esc(pl.name)}</span>${capCell(pl.caps[k])}</a>`).join('')}</div></div></section>
  <section class="band white"><div class="wrap"><div class="sec-head"><h2 class="h2">Also included</h2></div><div class="pillars three">${others.map((o) => featureCard(o, false)).join('')}</div></div></section>
  ${cta()}</main>`;
  return layout({ title: p.name, description: p.short, path: `/features/${slug}`, body });
}

/* ---------- Platforms ---------- */
const capTable = (list) => `<div class="table-scroll"><table class="cmp caps"><thead><tr><th>What Tharam checks</th>${list.map((p) => `<th><a href="/platforms/${p.slug}">${esc(p.name)}</a></th>`).join('')}</tr></thead><tbody>
  ${CAPS.map(([k, l]) => `<tr><td>${esc(l)}</td>${list.map((p) => `<td>${capCell(p.caps[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export function platformIndex() {
  const body = `<main>${pageHead({ eyebrow: 'Platforms', title: 'Works with the store you already have', lede: 'Tharam works with the store you already have: Shopify, WooCommerce, BigCommerce, Magento, Salesforce Commerce Cloud, Wix, Squarespace and custom-built stores.' })}
    <section class="band white"><div class="wrap"><div class="plat-grid">${PLATFORMS.map((p) => `<a class="plat" href="/platforms/${p.slug}"><div class="plat-h"><h3>${esc(p.name)}</h3>${badge(p.status)}</div><p>${esc(p.blurb)}</p><span class="more">Details ${icon('arrow', 14)}</span></a>`).join('')}</div></div></section>
    <section class="band"><div class="wrap"><div class="sec-head"><h2 class="h2">What works where</h2></div>${capTable(PLATFORMS)}</div></section>${cta()}</main>`;
  return layout({ title: 'Platforms', description: 'Tharam works with Shopify, WooCommerce, BigCommerce, Magento, Salesforce Commerce Cloud, Wix, Squarespace and custom-built stores.', path: '/platforms', body });
}

export function platform(slug) {
  const p = PLATFORMS.find((x) => x.slug === slug);
  if (!p) return null;
  const live = p.status === 'live';
  const short = p.name.split(' ')[0];
  const body = `<main>${pageHead({ eyebrow: 'Platforms', status: p.status, title: `Tharam for ${p.name}`, lede: p.blurb, actions: `<a class="btn" href="/#check">Check my ${esc(short)} store free</a>${live ? '<a class="btn secondary" href="/app#signup">Create free account</a>' : '<a class="btn secondary" href="/demo">Talk to us</a>'}` })}
  <section class="band white"><div class="wrap split">
    <div><h2 class="h2">What Tharam checks on ${esc(p.name)}</h2><ul class="cap-list">${CAPS.map(([k, l]) => `<li><span>${esc(l)}</span>${capCell(p.caps[k])}</li>`).join('')}</ul></div>
    <div>${p.notes.length ? `<div class="note-card"><h3>Good to know</h3><ul>${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      ${!live ? `<form class="note-card wl" data-waitlist="platform-${esc(p.slug)}" novalidate><h3>Join early access for ${esc(p.name)}</h3><p>Leave your email and store address and we’ll set up shopping tests for your store.</p>
        <input name="email" type="email" placeholder="you@yourstore.com" required aria-label="Email"><input name="url" type="text" placeholder="yourstore.com" aria-label="Store address"><button class="btn" type="submit">Join early access</button><p class="wl-msg" role="status"></p></form>` : ''}</div>
  </div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><h2 class="h2">What you get</h2></div><div class="pillars three">${PRODUCTS.slice(0, 3).map((o) => featureCard(o, false)).join('')}</div></div></section>
  ${cta(`See how your ${short} store is doing`)}</main>`;
  return layout({ title: `Tharam for ${p.name}`, description: p.blurb, path: `/platforms/${slug}`, body });
}

/* ---------- Marketplaces ---------- */
export function marketIndex() {
  const body = `<main>${pageHead({ eyebrow: 'Marketplaces', status: 'early', title: 'Sell on marketplaces too? We’ll watch those as well', lede: 'Most brands sell on their own store and on Amazon, Flipkart or other marketplaces. Tharam will watch your listings there and make sure prices, stock and product details match your own store.' })}
    <section class="band white"><div class="wrap"><div class="plat-grid">${MARKETPLACES.map((m) => `<a class="plat" href="/marketplaces/${m.slug}"><div class="plat-h"><h3>${esc(m.name)}</h3>${badge(m.status)}</div><p>${esc(m.blurb)}</p><span class="more">Details ${icon('arrow', 14)}</span></a>`).join('')}</div></div></section>
    <section class="band"><div class="wrap split"><div><p class="eyebrow">Only on Tharam</p><h2 class="h2">One set of products, checked everywhere you sell</h2><p class="body-l">The same product with a different price on two marketplaces. In stock on your store, but switched off on Flipkart. A description changed in one place only. Tharam already checks every product on your own store; soon it will compare them with your marketplace listings too.</p></div>
      <form class="note-card wl" data-waitlist="marketplaces" novalidate><h3>Join early access</h3><p>Tell us where you sell. We’re inviting brands in the order they join.</p><input name="email" type="email" placeholder="you@yourbrand.com" required aria-label="Email"><input name="url" type="text" placeholder="Your store and marketplaces" aria-label="Where you sell"><button class="btn" type="submit">Join early access</button><p class="wl-msg" role="status"></p></form></div></section>
    ${cta()}</main>`;
  return layout({ title: 'Marketplaces', description: 'Listing checks and matching prices, stock and product details for brands selling on Amazon, Flipkart, Meesho and Myntra.', path: '/marketplaces', body });
}

export function market(slug) {
  const m = MARKETPLACES.find((x) => x.slug === slug);
  if (!m) return null;
  const body = `<main>${pageHead({ eyebrow: 'Marketplaces', status: m.status, title: `Tharam for ${m.name} sellers`, lede: m.blurb })}
  <section class="band white"><div class="wrap split">
    <div><h2 class="h2">What Tharam will watch for you</h2><ul class="tick-list">${m.watch.map((w) => `<li>${icon('check', 16)}<span>${esc(w)}</span></li>`).join('')}</ul><p class="muted">Connected through ${esc(m.via)}</p></div>
    <form class="note-card wl" data-waitlist="marketplace-${esc(m.slug)}" novalidate><h3>Join ${esc(m.name)} early access</h3><p>We’re starting with brands that sell on ${esc(m.name)} and their own store.</p>
      <input name="email" type="email" placeholder="you@yourbrand.com" required aria-label="Email"><input name="url" type="text" placeholder="Your store or brand" aria-label="Store or brand"><button class="btn" type="submit">Join early access</button><p class="wl-msg" role="status"></p></form>
  </div></section>${cta('Start with your own store today')}</main>`;
  return layout({ title: `Tharam for ${m.name}`, description: m.blurb, path: `/marketplaces/${slug}`, body });
}

/* ---------- Pricing ---------- */
export function pricing() {
  const plan = (name, price, per, items, btn, hl) => `<div class="plan ${hl ? 'hl' : ''}">${hl ? '<span class="plan-tag">Available now</span>' : ''}<h3>${esc(name)}</h3><div class="price"><b>${esc(price)}</b><span>${esc(per)}</span></div><ul>${items.map((i) => `<li>${icon('check', 15)}<span>${esc(i)}</span></li>`).join('')}</ul>${btn}</div>`;
  const body = `<main>${pageHead({ eyebrow: 'Pricing', title: 'Free while we’re in beta', lede: 'Everything is free during the beta. We’ll tell you at least 30 days before any charge, and beta customers keep a founding discount for good.' })}
  <section class="band white"><div class="wrap"><div class="plans">
    ${plan('Beta', 'Free', 'right now', ['Up to 5 stores', 'Shopping checks as often as every hour', 'A full daily check, including design changes', 'Safe to publish and product checks', 'Email and Slack alerts'], '<a class="btn block" href="/app#signup">Create free account</a>', true)}
    ${plan('Starter', '$19', 'per store, per month, after the beta', ['Daily shopping checks', 'Speed, Google and mobile checks', 'Email alerts'], '<span class="plan-later">After the beta</span>')}
    ${plan('Growth', '$49', 'per store, per month, after the beta', ['Hourly shopping checks', 'Safe to publish', 'Product, price and design checks', 'Slack alerts'], '<span class="plan-later">After the beta</span>')}
    ${plan('Pro', '$99', 'per store, per month, after the beta', ['Checks every 15 minutes', 'AI that looks like a shopper', 'Priority support'], '<span class="plan-later">After the beta</span>')}
  </div>
  <div class="managed-band"><div><h3>Rather have us look after it?</h3><p>Our team watches your store, fixes what breaks and checks every change. Priced to your store.</p></div><a class="btn secondary" href="/managed">See the managed service</a></div>
  <p class="muted center">Agencies and brands with many stores: <a href="/demo">talk to us</a>. Marketplace checks are in early access.</p></div></section>
  ${faq(FAQ.slice(0, 4))}</main>`;
  return layout({ title: 'Pricing', description: 'Tharam is free during the beta. Plans after the beta, per store, and a managed service priced to your store.', path: '/pricing', body });
}

/** Puts an existing static page (its <main>, scripts and inline styles) into the site layout. */
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
