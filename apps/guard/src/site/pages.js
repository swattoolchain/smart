import fs from 'node:fs';
import path from 'node:path';
import { layout, esc, icon, badge, capCell, VERSION } from './layout.js';
export { VERSION };
import { PRODUCTS, PLATFORMS as PLATFORM_LIST, WOO_AVAILABLE, MARKETPLACES, CAPS, FAQ, MANAGED, AUDIENCES, PROMISES } from './content.js';
import { demoMarkup, demoScript } from './demo.js';
import { ZIP_NAME, pluginVersion } from '../wp-plugin.js';
import { isOn } from '../features.js';
import { listPlans, getPlan, setting, FEATURES } from '../license.js';

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
  ${saleBanner() ? `<div class="wrap">${saleBanner()}</div>` : ''}

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
  ${faq(faqList())}
  ${cta()}
  </main>`;
  return layout({ scripts: demoScript, title: '', description: 'Tharam checks your online store every few hours like a real customer and tells you the moment customers can’t buy. Product and price checks, tests for design changes, and AI that looks at your pages like a shopper. Free during the beta.', path: '/', body, alternates: { en: '/', de: '/de', fr: '/fr', es: '/es', 'x-default': '/' } });
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
  <section class="band"><div class="wrap"><div class="sec-head"><p class="eyebrow">What Tharam checks</p><h2 class="h2">Seven questions, answered for you every few hours</h2></div>
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
  const body = `<main>${pageHead({ eyebrow: 'Features', title: 'Everything that keeps your store selling', lede: 'One service, seven things it does for you. All of them are included in your Tharam plan.' })}
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
    <div class="support-grid">${platforms().map((pl) => `<a href="/platforms/${pl.slug}" class="sup"><span>${esc(pl.name)}</span>${capCell(pl.caps[k])}</a>`).join('')}</div></div></section>
  <section class="band white"><div class="wrap"><div class="sec-head"><h2 class="h2">Also included</h2></div><div class="pillars three">${others.map((o) => featureCard(o, false)).join('')}</div></div></section>
  ${cta()}</main>`;
  return layout({ title: p.name, description: p.short, path: `/features/${slug}`, body });
}

/* ---------- Platforms ---------- */
const faqList = () => (isOn('woocommerce') ? FAQ.map((f) => (/^Does it work with my store/.test(f[0]) ? [f[0], 'Yes. Tharam works with Shopify, WooCommerce, BigCommerce, Magento, Wix, Squarespace and custom-built stores. Shopify and WooCommerce stores get shopping tests; other platforms are joining early access for them.'] : f)) : FAQ);
/** The platform list as it is today: WooCommerce says its shopping tests are available once that switch is on. */
const platforms = () => PLATFORM_LIST.map((p) => (p.slug === 'woocommerce' && isOn('woocommerce') ? { ...p, ...WOO_AVAILABLE } : p));
const capTable = (list) => `<div class="table-scroll"><table class="cmp caps"><thead><tr><th>What Tharam checks</th>${list.map((p) => `<th><a href="/platforms/${p.slug}">${esc(p.name)}</a></th>`).join('')}</tr></thead><tbody>
  ${CAPS.map(([k, l]) => `<tr><td>${esc(l)}</td>${list.map((p) => `<td>${capCell(p.caps[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export function platformIndex() {
  const body = `<main>${pageHead({ eyebrow: 'Platforms', title: 'Works with the store you already have', lede: 'Tharam works with the store you already have: Shopify, WooCommerce, BigCommerce, Magento, Salesforce Commerce Cloud, Wix, Squarespace and custom-built stores.' })}
    <section class="band white"><div class="wrap"><div class="plat-grid">${platforms().map((p) => `<a class="plat" href="/platforms/${p.slug}"><div class="plat-h"><h3>${esc(p.name)}</h3>${badge(p.status)}</div><p>${esc(p.blurb)}</p><span class="more">Details ${icon('arrow', 14)}</span></a>`).join('')}</div></div></section>
    <section class="band"><div class="wrap"><div class="sec-head"><h2 class="h2">What works where</h2></div>${capTable(platforms())}</div></section>${cta()}</main>`;
  return layout({ title: 'Platforms', description: 'Tharam works with Shopify, WooCommerce, BigCommerce, Magento, Salesforce Commerce Cloud, Wix, Squarespace and custom-built stores.', path: '/platforms', body });
}

const wooPlugin = () => `<section class="band white" id="plugin"><div class="wrap split">
    <div><p class="eyebrow">WordPress plugin</p><h2 class="h2">Let Tharam in, and link your store with a code</h2>
      <p class="body-l">Security and caching plugins sometimes stop a test shopper the same way they stop a bot. The Tharam Store Guard plugin makes sure ours gets through, and it shows a short code that links your store to your Tharam account.</p>
      <p><a class="btn" href="/downloads/${ZIP_NAME}" download>Download the plugin (v${esc(pluginVersion())})</a></p>
      <p class="fine">Free. No passwords or keys inside. It never reads orders or customers.</p></div>
    <div class="note-card"><h3>Install in three steps</h3><ol>
      <li>In WordPress, open Plugins, then Add New, then Upload Plugin. Choose the file you downloaded and press Activate.</li>
      <li>Open Tools, then Tharam. You will see your link code.</li>
      <li>Paste the code into Tharam when you add your store.</li></ol>
      <p>Still blocked by a firewall such as Wordfence, Sucuri or Cloudflare? Allow visitors whose User Agent contains <code>TharamStoreGuard</code>.</p></div>
  </div></section>`;

export function platform(slug) {
  const p = platforms().find((x) => x.slug === slug);
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
  ${slug === 'woocommerce' ? wooPlugin() : ''}
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
const FREQ = { 30: 'Every 30 minutes', 60: 'Every hour', 180: 'Every 3 hours', 360: 'Every 6 hours', 720: 'Twice a day', 1440: 'Once a day', 10080: 'Once a week' };
const fmtMoney = (minor, cur) => { try { return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100); } catch { return `${minor / 100} ${cur}`; } };

/** Built from the plans in the founder console, so the page and what customers get never disagree. */
export function pricing() {
  const plans = listPlans().filter((p) => p.public && p.active);
  const signup = getPlan(setting('signup_plan'));
  const betaOn = signup?.kind === 'free' && signup.public;
  const grace = Number(setting('grace_days')) || 0;
  const curs = [...new Set(plans.flatMap((p) => Object.keys(p.prices)))].sort((a, b) => ['USD', 'EUR', 'GBP', 'INR'].indexOf(a) - ['USD', 'EUR', 'GBP', 'INR'].indexOf(b));
  const priceBlock = (p) => {
    if (p.kind !== 'paid') return `<div class="price"><b>Free</b><span>${betaOn && p.key === signup.key ? 'while we’re in beta' : p.kind === 'trial' ? 'trial' : ''}</span></div>`;
    return `<div class="price" data-prices='${esc(JSON.stringify(Object.fromEntries(Object.entries(p.prices).map(([c, v]) => [c, { m: v.month != null ? fmtMoney(v.month, c) : null, y: v.year != null ? fmtMoney(Math.round(v.year / 1200) * 100, c) : null, yt: v.year != null ? fmtMoney(v.year, c) : null }]))))}'>
      <b class="pv">${fmtMoney(p.prices[curs[0]]?.month ?? 0, curs[0])}</b><span class="pp">per store, per month</span></div><p class="py muted"></p>`;
  };
  const featsOf = (p) => FEATURES.filter((f) => p.features.includes(f.key)).map((f) => f.label);
  const card = (p) => `<div class="plan ${p.highlight ? 'hl' : ''}">${p.highlight ? `<span class="plan-tag">${betaOn && p.key === signup.key ? 'Available now' : 'Most popular'}</span>` : ''}<h3>${esc(p.name)}</h3><p class="plan-sub">${esc(p.tagline || '')}</p>${priceBlock(p)}
    <ul>${[`Shopping checks ${FREQ[p.limits.journeyMinInterval]?.toLowerCase() || ''}`, `Full check ${FREQ[p.limits.fullMinInterval]?.toLowerCase() || ''}`, p.limits.maxStores ? `Up to ${p.limits.maxStores} stores` : 'As many stores as you need', ...featsOf(p).slice(1)].map((i) => `<li>${icon('check', 15)}<span>${esc(i)}</span></li>`).join('')}</ul>
    ${p.kind === 'paid' && betaOn ? '<span class="plan-later">After the beta</span>' : `<a class="btn block ${p.highlight ? '' : 'secondary'}" href="/app#signup">${p.kind === 'paid' ? `Choose ${esc(p.name)}` : 'Create free account'}</a>`}</div>`;
  const yes = `<span class="cap-yes">${icon('check', 15)}</span>`, no = '<span class="muted">–</span>';
  const rows = [
    ['Price per store, per month', (p) => (p.kind !== 'paid' ? 'Free' : `<span class="pv-cell" data-prices='${esc(JSON.stringify(Object.fromEntries(Object.entries(p.prices).map(([c, v]) => [c, v.month != null ? fmtMoney(v.month, c) : '–']))))}'>${fmtMoney(p.prices[curs[0]]?.month ?? 0, curs[0])}</span>`)],
    ['Stores', (p) => (p.limits.maxStores ? `Up to ${p.limits.maxStores}` : 'Any number')],
    ['Shopping checks', (p) => esc(FREQ[p.limits.journeyMinInterval] || '–')],
    ['Full check', (p) => esc(FREQ[p.limits.fullMinInterval] || '–')],
    ...FEATURES.filter((f) => !f.always).map((f) => [f.label, (p) => (p.features.includes(f.key) ? yes : no)]),
    ['Saved staging environments per store', (p) => (p.features.includes('environments') ? String(p.limits.environments) : no)],
  ];
  const table = `<div class="table-scroll"><table class="compare"><thead><tr><th></th>${plans.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(([label, fn]) => `<tr><td>${esc(label)}</td>${plans.map((p) => `<td>${fn(p)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const switches = curs.length ? `<div class="price-switch"><div class="seg" role="radiogroup" aria-label="Billing">${[['m', 'Monthly'], ['y', 'Yearly']].map(([k, l], i) => `<label><input type="radio" name="bill" value="${k}" ${i ? '' : 'checked'}><span>${l}</span></label>`).join('')}</div>
    ${curs.length > 1 ? `<div class="seg" role="radiogroup" aria-label="Currency">${curs.map((c, i) => `<label><input type="radio" name="cur" value="${c}" ${i ? '' : 'checked'}><span>${c}</span></label>`).join('')}</div>` : ''}</div>` : '';
  const how = [
    ['One plan, priced per store', 'Your plan decides what each store gets. You pay the plan’s price for every store you add. Two stores on Growth cost twice the Growth price.'],
    ['Add or remove stores any time', 'Need another store? It’s added at your plan’s price per store. Remove one and you stop paying for it at your next renewal.'],
    ['Pay yearly, get two months free', 'Yearly plans cost ten months of the monthly price.'],
    ['A late payment never stops your store checks', `If a renewal is late, checks keep running for ${grace} days so nothing is missed. After that they pause, and your reports and settings are kept until you renew.`],
  ];
  const body = `<main>${pageHead({ eyebrow: 'Pricing', title: betaOn ? 'Free while we’re in beta. Simple pricing after.' : 'Simple pricing, per store', lede: betaOn ? 'Everything is free during the beta. When paid plans start, we’ll tell you at least 30 days before, and beta customers keep a founding discount.' : 'Choose what each store gets. Pay per store, monthly or yearly. Add or remove stores any time.' })}
  <section class="band white"><div class="wrap">${switches}<div class="plans">${plans.map(card).join('')}</div>
  <div class="managed-band"><div><h3>Rather have us look after it?</h3><p>Our team watches your store, fixes what breaks and checks every change. Priced to your store.</p></div><a class="btn secondary" href="/managed">See the managed service</a></div>
  <p class="muted center">Agencies and brands with 10 or more stores: <a href="/demo">talk to us</a> about volume pricing.</p></div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><p class="eyebrow">Compare plans</p><h2 class="h2">What each plan includes</h2></div>${table}</div></section>
  <section class="band white"><div class="wrap"><div class="sec-head"><p class="eyebrow">How billing works</p><h2 class="h2">No surprises</h2></div>
    <div class="features">${how.map(([t, d]) => `<div class="feature"><span class="ft-ic">${icon('check', 16)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
  ${faq(faqList().slice(0, 4))}</main>`;
  const script = `<script>(function(){var tz='';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}
var pick=tz==='Asia/Kolkata'||tz==='Asia/Calcutta'?'INR':/^Europe\\//.test(tz)&&tz!=='Europe/London'?'EUR':tz==='Europe/London'?'GBP':'USD';
var r=document.querySelector('input[name=cur][value='+pick+']');if(r)r.checked=true;
function draw(){var b=(document.querySelector('input[name=bill]:checked')||{}).value||'m';var c=(document.querySelector('input[name=cur]:checked')||{}).value||${JSON.stringify(curs[0] || 'USD')};
document.querySelectorAll('.price[data-prices]').forEach(function(el){var p=JSON.parse(el.getAttribute('data-prices'));var v=p[c]||p[Object.keys(p)[0]];var y=b==='y'&&v.y;
el.querySelector('.pv').textContent=y?v.y:v.m;el.querySelector('.pp').textContent=y?'per store, per month, billed yearly':'per store, per month';var n=el.nextElementSibling;if(n&&n.classList.contains('py'))n.textContent=y?v.yt+' per store, per year':'';});
document.querySelectorAll('.pv-cell').forEach(function(el){var p=JSON.parse(el.getAttribute('data-prices'));el.textContent=p[c]||p[Object.keys(p)[0]];});}
document.querySelectorAll('input[name=bill],input[name=cur]').forEach(function(i){i.addEventListener('change',draw)});draw();})();</script>`;
  return layout({ title: 'Pricing', description: 'Tharam pricing: one plan, priced per store, monthly or yearly. Free during the beta.', path: '/pricing', body, scripts: script });
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

/* ---------- Deutsch ---------- */
// A German landing page for shops selling in Germany and Austria. The rest of the site follows.
export function deHome() {
  const form = `<form class="check-form" id="check-form" novalidate data-empty="Geben Sie die Adresse Ihres Shops ein, z. B. ihrshop.de" data-starting="Wird gestartet…" data-failed="Die Prüfung konnte nicht starten. Bitte erneut versuchen."><label for="de-url" class="sr-only">Adresse Ihres Shops</label>
  <input id="de-url" name="url" type="text" inputmode="url" autocomplete="url" placeholder="ihrshop.de" required><button class="btn" type="submit">Shop kostenlos prüfen</button></form>
  <p class="error-msg" id="check-err" role="alert"></p>`;
  const feats = [
    ['pulse', 'Kann man bei Ihnen kaufen?', 'Shop-Prüfung rund um die Uhr', 'Alle paar Stunden kauft Tharam bei Ihnen ein wie ein echter Kunde: suchen, Größe wählen, in den Warenkorb, zur Kasse. Funktioniert etwas nicht, erfahren Sie es sofort.'],
    ['globe', 'Halten Sie die Regeln ein?', 'Rechtssicher in Deutschland und Österreich', 'Impressum, Widerrufsbelehrung, der neue Button „Vertrag widerrufen“, „inkl. MwSt., zzgl. Versand“, Grundpreise, Cookie-Einwilligung und Barrierefreiheit nach BFSG.'],
    ['publish', 'Ist die Änderung sicher?', 'Sicher veröffentlichen', 'Neues Theme oder Sale-Banner? Tharam testet die neue Version neben Ihrem Live-Shop und sagt klar: veröffentlichen, erst ansehen, oder noch nicht.'],
    ['catalog', 'Stimmen Ihre Produkte?', 'Produkt- und Preisprüfung', 'Jedes Produkt wird geprüft: Preise von 0 €, Scheinrabatte, Platzhaltertexte, fehlende Fotos und doppelte Artikelnummern.'],
    ['speed', 'Schnell und auffindbar?', 'Tempo, Google und Mobil', 'Langsame Seiten am Handy, Seiten, die Google nicht sieht, und kaputte Links: die leisen Dinge, die Umsatz kosten.'],
    ['sparkle', 'Was würde ein Mensch bemerken?', 'KI, die wie ein Kunde schaut', 'KI sieht sich Ihre Seiten an und liest Ihre Produkttexte, wie es ein Kunde tun würde.'],
  ];
  const checks = [
    ['Impressum', 'Verlinkt auf jeder Seite, mit Anschrift und E-Mail.'],
    ['Widerrufsbelehrung', 'Veröffentlicht, mit der 14-Tage-Frist.'],
    ['„Vertrag widerrufen“', 'Der Widerrufsbutton, Pflicht seit dem 19. Juni 2026.'],
    ['Preisangaben', '„inkl. MwSt.“ und Versandkosten beim Preis, Grundpreise bei Gewicht und Volumen.'],
    ['Cookie-Einwilligung', 'Banner beim ersten Besuch, und kein Meta-, TikTok- oder Google-Tracking vor der Zustimmung.'],
    ['Barrierefreiheit', 'Kaufen per Tastatur, Zoom, Sprache der Seite, Warenkorb nach WCAG 2.1 AA, Erklärung zur Barrierefreiheit.'],
    ['Alte OS-Plattform', 'Hinweise auf die EU-Streitschlichtung, die am 20. Juli 2025 abgeschaltet wurde.'],
  ];
  const body = `<main lang="de">
  <section class="hero2"><div class="wrap">
    <div class="h2-copy"><p class="eyebrow">KI-gestützte Shop-Prüfung für Online-Händler</p>
      <h1>Damit Kunden immer bei Ihnen kaufen können.</h1>
      <p class="lede">Ein kaputter Warenkorb-Button, ein falscher Preis, ein fehlendes Impressum: kleine Fehler, die still Umsatz kosten oder eine Abmahnung bringen. Tharam prüft Ihren Shop alle paar Stunden wie ein echter Kunde und meldet sich, sobald etwas nicht stimmt.</p>
      <div id="check">${form}</div>
      <p class="fine">Kostenlos. Dauert etwa zwei Minuten. Keine Installation, kein Konto, keine Bestellungen. <span class="lang-links"><a href="/" hreflang="en" lang="en">English</a> · <a href="/fr" hreflang="fr" lang="fr">Français</a> · <a href="/es" hreflang="es" lang="es">Español</a></span></p></div>
    ${heroVisual}
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Für Shops in Deutschland und Österreich</p><h2 class="h2">Was Tharam bei jeder vollständigen Prüfung kontrolliert</h2>
      <p class="body-l">Automatische Prüfungen mit klaren Hinweisen, wo Sie es in Shopify beheben. Keine Rechtsberatung: Sie sehen genau, was wir gefunden haben, und entscheiden selbst oder mit Ihrer Kanzlei.</p></div>
    <div class="features">${checks.map(([t, d]) => `<div class="feature"><span class="ft-ic">${icon('check', 16)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
  </div></section>

  <section class="band"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Was Tharam tut</p><h2 class="h2">Alles, was eine sorgfältige Shop-Leitung prüfen würde, alle paar Stunden</h2></div>
    <div class="pillars">${feats.map(([ic, k, t, d]) => `<div class="pillar"><span class="pl-ic">${icon(ic, 20)}</span><span class="pl-k">${esc(k)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
  </div></section>

  <section class="cta-band"><div class="wrap"><div><h2>Wie steht Ihr Shop da? Kostenlos prüfen.</h2><p>Etwa zwei Minuten. Nichts installieren, kein Konto, keine Bestellungen.</p></div>
    <div class="cta-actions"><a class="btn light" href="#check">Shop kostenlos prüfen</a><a class="btn ghost-light" href="mailto:hello@tharam.store?subject=Tharam%20Deutschland">Kontakt aufnehmen</a></div></div></section>
  </main>`;
  return layout({ lang: 'de', title: 'Shop-Prüfung für Deutschland und Österreich', description: 'Tharam prüft Ihren Online-Shop alle paar Stunden wie ein echter Kunde: Kaufprozess, Preise, Impressum, Widerrufsbutton, Cookie-Einwilligung und Barrierefreiheit.', path: '/de', body, alternates: { en: '/', de: '/de', fr: '/fr', es: '/es', 'x-default': '/' } });
}

/* ---------- Sale readiness (Black Friday and festive sales) ---------- */
/** The next Black Friday: the day after the fourth Thursday of November. */
function nextBlackFriday(now = new Date()) {
  for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const nov1 = new Date(Date.UTC(y, 10, 1));
    const firstThu = 1 + ((4 - nov1.getUTCDay() + 7) % 7);
    const bf = new Date(Date.UTC(y, 10, firstThu + 21 + 1));
    if (bf.getTime() + 864e5 > now.getTime()) return bf;
  }
}
export function saleBanner() {
  const bf = nextBlackFriday();
  const days = Math.ceil((bf - Date.now()) / 864e5);
  if (days > 60) return '';
  return `<a class="sale-strip" href="/sale-ready"><span class="ss-tag">Black Friday</span><span>${days <= 0 ? 'It’s Black Friday.' : `${days} day${days === 1 ? '' : 's'} to Black Friday.`} Find out if your store is ready before your customers do.</span>${icon('arrow', 15)}</a>`;
}
export function saleReady() {
  const bf = nextBlackFriday();
  const days = Math.max(0, Math.ceil((bf - Date.now()) / 864e5));
  const when = bf.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const before = [
    ['Every price and sale price', 'Every product checked: prices of zero, “sale” prices that aren’t lower, prices that dropped by more than half after an import, and products that are sold out.'],
    ['The sale design, before it goes live', 'Your Black Friday theme or banner tested next to your live store on phone, tablet and computer. We tell you if the banner covers the Buy button or breaks Add to cart.'],
    ['Buying, start to finish', 'Search, product, size, Add to cart, cart and checkout, on a phone, the way most sale shoppers buy.'],
    ['Apps added for the sale', 'Countdown timers, popups and upsell apps are the usual cause of a broken Add to cart. We catch script errors and slow apps before the rush.'],
    ['Speed on phones', 'Sale pages get heavy. We measure load time and flag the apps that slow you down.'],
    ['Discount rules in the EU and UK', 'Selling in Europe? A discount must be measured against your lowest price in the last 30 days. We show you products where that doesn’t hold.', true],
    ['Discount codes that really work', 'Each of your sale codes applied to a real cart, every day: the price drops by the amount you expect, and we tell you if a code needs a minimum order. Before you email it to 50,000 customers.'],
  ];
  const during = [
    ['Sale mode: checks every 30 minutes', 'For your sale week, your store is shopped like a customer every 30 minutes, with a full check of prices and codes every 6 hours, whatever your plan.'],
    ['Alerts in minutes', 'Email and Slack the moment buying breaks, with the reason and how to fix it. One more when it’s fixed.'],
    ['Money at risk, in rupees, dollars or euros', 'How long customers couldn’t buy and what that cost, so you know what to fix first next year.'],
  ];
  const feats = (list) => `<div class="features">${list.map(([t, d, early]) => `<div class="feature"><span class="ft-ic">${icon('check', 16)}</span><h3>${esc(t)} ${early ? badge('soon') : ''}</h3><p>${esc(d)}</p></div>`).join('')}</div>`;
  const body = `<main>${pageHead({ eyebrow: `Black Friday is ${when}${days ? `, ${days} days away` : ''}`, title: 'Is your store ready for the sale?', lede: 'The worst time to find a broken Add to cart button is on your biggest sales day. Tharam checks everything that usually goes wrong in a sale, before it starts and all through it. For Black Friday, Cyber Monday, Diwali, Boxing Day and your own sales.', actions: '<a class="btn" href="/#check">Check my store free</a><a class="btn secondary" href="/managed">Have us check it for you</a>' })}
  <section class="band white"><div class="wrap"><div class="sec-head"><p class="eyebrow">Before the sale</p><h2 class="h2">What breaks on sale day, checked weeks before</h2></div>${feats(before)}</div></section>
  <section class="band"><div class="wrap"><div class="sec-head"><p class="eyebrow">During the sale</p><h2 class="h2">Someone watching your store all weekend</h2></div>${feats(during)}</div></section>
  <section class="band white"><div class="wrap split"><div><p class="eyebrow">A simple plan</p><h2 class="h2">Three weeks out, one week out, sale day</h2></div>
    <ol class="steps-list"><li><b>Three weeks before:</b> run a full check. Fix wrong prices, slow apps and anything that breaks buying.</li>
      <li><b>One week before:</b> check your sale theme and banners with Safe to publish, on a phone.</li>
      <li><b>Sale week:</b> we switch on sale mode, checking every 30 minutes, and your phone gets an alert the moment buying breaks.</li></ol></div></section>
  ${faq([['Do you load test my store?', 'No. Shopify handles sale-day traffic for you. What actually breaks on sale day is usually an app, a price, a discount or a new banner, and that’s what we check.'], ['Will your tests place orders?', 'Never. Our checkout test stops before payment and empties the cart.'], ['Can you do this for us?', 'Yes. With the managed service, our team runs the checks, reviews your sale design and watches your store through the sale.']])}
  ${cta('Find out if your store is ready', 'Free check in about two minutes. Nothing to install, no orders placed.')}</main>`;
  return layout({ title: 'Black Friday sale readiness', description: 'Check your store is ready for Black Friday, Cyber Monday and festive sales: prices, sale designs, checkout, apps, speed and discount rules, before and during the sale.', path: '/sale-ready', body });
}

/* ---------- Français and Español ---------- */
// Landing pages for shops selling in French- and Spanish-speaking markets, built like the German one.
// They only describe checks Tharam runs today (no country legal pack yet for France or Spain).
const LANG_ALTERNATES = { en: '/', de: '/de', fr: '/fr', es: '/es', 'x-default': '/' };
const LOCAL = {
  fr: {
    path: '/fr',
    title: 'Vérification de boutique en ligne',
    description: 'Tharam vérifie votre boutique en ligne toutes les quelques heures comme un vrai client : panier, paiement, prix, consentement aux cookies, accessibilité et vitesse sur mobile.',
    empty: 'Saisissez l’adresse de votre boutique, par exemple votreboutique.fr', starting: 'Démarrage…', failed: 'La vérification n’a pas pu démarrer. Réessayez.',
    placeholder: 'votreboutique.fr', label: 'Adresse de votre boutique', button: 'Vérifier ma boutique gratuitement',
    eyebrow: 'Vérification de boutique par IA pour les e-commerçants',
    h1: 'Pour que vos clients puissent toujours acheter chez vous.',
    lede: 'Un bouton « Ajouter au panier » qui ne répond plus, un prix à 0 €, un bandeau cookies absent : de petites erreurs qui coûtent des ventes sans bruit. Tharam vérifie votre boutique toutes les quelques heures comme un vrai client et vous prévient dès que quelque chose ne va pas.',
    fine: 'Gratuit. Environ deux minutes. Rien à installer, pas de compte, aucune commande.',
    checksEyebrow: 'Pour les boutiques qui vendent en France et en Europe',
    checksH2: 'Ce que Tharam contrôle à chaque vérification complète',
    checksIntro: 'Des contrôles automatiques avec des indications claires pour corriger dans Shopify. Ce n’est pas un conseil juridique : vous voyez exactement ce que nous avons trouvé et vous décidez.',
    checks: [
      ['Parcours d’achat', 'Page d’accueil, fiche produit, ajout au panier et ouverture du paiement, sur téléphone et sur ordinateur. Nous nous arrêtons avant de payer.'],
      ['Consentement aux cookies', 'Le bandeau s’affiche à la première visite, et aucun suivi Meta, TikTok ou Google ne part avant l’accord du client.'],
      ['Accessibilité', 'Achat au clavier, zoom autorisé, langue de la page, panier conforme WCAG 2.1 AA et déclaration d’accessibilité, comme le demande l’Acte européen sur l’accessibilité.'],
      ['Prix et produits', 'Prix à 0 €, fausses remises, textes provisoires, photos manquantes et références en double.'],
      ['Codes promo', 'Vos codes appliqués à un vrai panier : le prix baisse vraiment, du montant prévu.'],
      ['Conditions de la boutique', 'Politique de confidentialité, de remboursement, conditions générales et livraison publiées.'],
    ],
    whatEyebrow: 'Ce que fait Tharam',
    whatH2: 'Tout ce qu’une équipe attentive vérifierait, toutes les quelques heures',
    feats: [
      ['pulse', 'Peut-on acheter chez vous ?', 'Vérification jour et nuit', 'Toutes les quelques heures, Tharam fait ses achats chez vous comme un vrai client : chercher, choisir une taille, ajouter au panier, aller au paiement. Si quelque chose casse, vous le savez tout de suite.'],
      ['publish', 'Ce changement est-il sûr ?', 'Publier en toute sécurité', 'Nouveau thème ou bannière de soldes ? Tharam teste la nouvelle version à côté de votre boutique en ligne et vous dit clairement : publier, vérifier d’abord, ou pas encore.'],
      ['catalog', 'Vos produits sont-ils justes ?', 'Contrôle des produits et des prix', 'Chaque produit est vérifié : prix à 0 €, fausses remises, textes provisoires, photos manquantes et références en double.'],
      ['speed', 'Rapide et visible ?', 'Vitesse, Google et mobile', 'Pages lentes sur téléphone, pages que Google ne voit pas et liens cassés : les petites choses qui coûtent des ventes.'],
      ['sparkle', 'Que remarquerait un client ?', 'Une IA qui regarde comme un client', 'L’IA regarde vos pages et lit vos fiches produit comme le ferait un client.'],
    ],
    ctaH2: 'Où en est votre boutique ? Vérifiez gratuitement.',
    ctaP: 'Environ deux minutes. Rien à installer, pas de compte, aucune commande.',
    contact: 'Nous contacter', subject: 'Tharam%20France',
  },
  es: {
    path: '/es',
    title: 'Revisión de tiendas online',
    description: 'Tharam revisa su tienda online cada pocas horas como un cliente real: carrito, pago, precios, consentimiento de cookies, accesibilidad y velocidad en el móvil.',
    empty: 'Escriba la dirección de su tienda, por ejemplo sutienda.es', starting: 'Iniciando…', failed: 'No se pudo iniciar la revisión. Inténtelo de nuevo.',
    placeholder: 'sutienda.es', label: 'Dirección de su tienda', button: 'Revisar mi tienda gratis',
    eyebrow: 'Revisión de tiendas con IA para comercios online',
    h1: 'Para que sus clientes siempre puedan comprarle.',
    lede: 'Un botón «Añadir al carrito» que no funciona, un precio de 0 €, un aviso de cookies que no aparece: pequeños fallos que cuestan ventas sin que nadie lo note. Tharam revisa su tienda cada pocas horas como un cliente real y le avisa en cuanto algo falla.',
    fine: 'Gratis. Unos dos minutos. Sin instalar nada, sin cuenta, sin pedidos.',
    checksEyebrow: 'Para tiendas que venden en España y en Europa',
    checksH2: 'Lo que Tharam comprueba en cada revisión completa',
    checksIntro: 'Comprobaciones automáticas con indicaciones claras para corregirlo en Shopify. No es asesoramiento legal: usted ve exactamente lo que encontramos y decide.',
    checks: [
      ['Proceso de compra', 'Página de inicio, ficha de producto, añadir al carrito y abrir el pago, en el móvil y en el ordenador. Paramos antes de pagar.'],
      ['Consentimiento de cookies', 'El aviso aparece en la primera visita, y no se activa ningún seguimiento de Meta, TikTok o Google antes de que el cliente acepte.'],
      ['Accesibilidad', 'Comprar con el teclado, zoom permitido, idioma de la página, carrito conforme a WCAG 2.1 AA y declaración de accesibilidad, como pide la Ley Europea de Accesibilidad.'],
      ['Precios y productos', 'Precios de 0 €, descuentos falsos, textos de relleno, fotos que faltan y referencias repetidas.'],
      ['Códigos de descuento', 'Sus códigos aplicados a un carrito real: el precio baja de verdad, en la cantidad prevista.'],
      ['Políticas de la tienda', 'Privacidad, devoluciones, condiciones y envíos publicados.'],
    ],
    whatEyebrow: 'Lo que hace Tharam',
    whatH2: 'Todo lo que revisaría un equipo cuidadoso, cada pocas horas',
    feats: [
      ['pulse', '¿Se puede comprar en su tienda?', 'Revisión día y noche', 'Cada pocas horas, Tharam compra en su tienda como un cliente real: buscar, elegir una talla, añadir al carrito, ir al pago. Si algo falla, lo sabrá enseguida.'],
      ['publish', '¿Es seguro este cambio?', 'Publicar con seguridad', '¿Tema nuevo o banner de rebajas? Tharam prueba la nueva versión junto a su tienda en vivo y le dice claramente: publicar, revisar antes o todavía no.'],
      ['catalog', '¿Sus productos están bien?', 'Revisión de productos y precios', 'Se revisa cada producto: precios de 0 €, descuentos falsos, textos de relleno, fotos que faltan y referencias repetidas.'],
      ['speed', '¿Rápida y visible?', 'Velocidad, Google y móvil', 'Páginas lentas en el móvil, páginas que Google no ve y enlaces rotos: las pequeñas cosas que cuestan ventas.'],
      ['sparkle', '¿Qué notaría un cliente?', 'IA que mira como un cliente', 'La IA mira sus páginas y lee sus textos de producto como lo haría un cliente.'],
    ],
    ctaH2: '¿Cómo está su tienda? Revísela gratis.',
    ctaP: 'Unos dos minutos. Sin instalar nada, sin cuenta, sin pedidos.',
    contact: 'Contactar', subject: 'Tharam%20Espa%C3%B1a',
  },
};
const OTHER_LANGS = [['/', 'en', 'English'], ['/de', 'de', 'Deutsch'], ['/fr', 'fr', 'Français'], ['/es', 'es', 'Español']];

function localHome(lang) {
  const L = LOCAL[lang];
  const form = `<form class="check-form" id="check-form" novalidate data-empty="${esc(L.empty)}" data-starting="${esc(L.starting)}" data-failed="${esc(L.failed)}"><label for="${lang}-url" class="sr-only">${esc(L.label)}</label>
  <input id="${lang}-url" name="url" type="text" inputmode="url" autocomplete="url" placeholder="${esc(L.placeholder)}" required><button class="btn" type="submit">${esc(L.button)}</button></form>
  <p class="error-msg" id="check-err" role="alert"></p>`;
  const others = OTHER_LANGS.filter(([, l]) => l !== lang).map(([href, l, name]) => `<a href="${href}" hreflang="${l}" lang="${l}">${name}</a>`).join(' · ');
  const body = `<main lang="${lang}">
  <section class="hero2"><div class="wrap">
    <div class="h2-copy"><p class="eyebrow">${esc(L.eyebrow)}</p>
      <h1>${esc(L.h1)}</h1>
      <p class="lede">${esc(L.lede)}</p>
      <div id="check">${form}</div>
      <p class="fine">${esc(L.fine)} <span class="lang-links">${others}</span></p></div>
    ${heroVisual}
  </div></section>

  <section class="band white"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">${esc(L.checksEyebrow)}</p><h2 class="h2">${esc(L.checksH2)}</h2>
      <p class="body-l">${esc(L.checksIntro)}</p></div>
    <div class="features">${L.checks.map(([t, d]) => `<div class="feature"><span class="ft-ic">${icon('check', 16)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
  </div></section>

  <section class="band"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">${esc(L.whatEyebrow)}</p><h2 class="h2">${esc(L.whatH2)}</h2></div>
    <div class="pillars">${L.feats.map(([ic, k, t, d]) => `<div class="pillar"><span class="pl-ic">${icon(ic, 20)}</span><span class="pl-k">${esc(k)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
  </div></section>

  <section class="cta-band"><div class="wrap"><div><h2>${esc(L.ctaH2)}</h2><p>${esc(L.ctaP)}</p></div>
    <div class="cta-actions"><a class="btn light" href="#check">${esc(L.button)}</a><a class="btn ghost-light" href="mailto:hello@tharam.store?subject=${L.subject}">${esc(L.contact)}</a></div></div></section>
  </main>`;
  return layout({ lang, title: L.title, description: L.description, path: L.path, body, alternates: LANG_ALTERNATES });
}
export const frHome = () => localHome('fr');
export const esHome = () => localHome('es');
