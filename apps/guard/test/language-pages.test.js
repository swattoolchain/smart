// French and Spanish website pages (T50), built like the German one: their own language, the free check form,
// links between all language versions, and hreflang alternates so Google shows each country the right page.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const PAGES = [
  { path: '/fr', lang: 'fr', h1: /Pour que vos clients puissent toujours acheter chez vous/, button: 'Vérifier ma boutique gratuitement', empty: /Saisissez l’adresse de votre boutique/, words: [/Consentement aux cookies/, /Acte européen sur l’accessibilité/, /Publier en toute sécurité/] },
  { path: '/es', lang: 'es', h1: /Para que sus clientes siempre puedan comprarle/, button: 'Revisar mi tienda gratis', empty: /Escriba la dirección de su tienda/, words: [/Consentimiento de cookies/, /Ley Europea de Accesibilidad/, /Publicar con seguridad/] },
];
const ALL = { en: '/', de: '/de', fr: '/fr', es: '/es' };

describe('French and Spanish pages', () => {
  let P, browser;
  before(async () => {
    P = await startProduct();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P?.stop(); });
  const get = async (path) => { const r = await fetch(P.base + path); return { status: r.status, html: await r.text() }; };

  for (const pg of PAGES) {
    it(`${pg.path} is in ${pg.lang}, with the free check form and its own title and description`, async () => {
      const { status, html } = await get(pg.path);
      assert.equal(status, 200);
      assert.match(html, new RegExp(`<html lang="${pg.lang}">`));
      assert.match(html, new RegExp(`<main lang="${pg.lang}">`));
      assert.match(html, pg.h1);
      assert.match(html, /<title>[^<]+ – Tharam<\/title>/);
      assert.match(html, new RegExp(`<link rel="canonical" href="https://tharam.store${pg.path}">`));
      assert.match(html, /id="check-form"/);
      for (const w of pg.words) assert.match(html, w);
      const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
      assert.doesNotMatch(main, /\b(Check my store|Run free check|Customers can buy)\b/, 'no English left in the page body');
      assert.doesNotMatch(main, /Impressum|Vertrag widerrufen/, 'German-only legal checks are not promised here');
    });
  }

  it('every language version lists all the others as hreflang alternates, and the footer links to each', async () => {
    for (const path of Object.values(ALL)) {
      const { status, html } = await get(path);
      assert.equal(status, 200, path);
      for (const [l, h] of Object.entries(ALL)) assert.match(html, new RegExp(`<link rel="alternate" hreflang="${l}" href="https://tharam.store${h}">`), `${path} → ${l}`);
      assert.match(html, /<link rel="alternate" hreflang="x-default" href="https:\/\/tharam.store\/">/);
      for (const [h, name] of [['/de', 'Deutsch'], ['/fr', 'Français'], ['/es', 'Español']]) assert.match(html, new RegExp(`<a href="${h}">${name}</a>`), `footer of ${path}`);
    }
    const de = (await get('/de')).html;
    assert.match(de, /<a href="\/fr" hreflang="fr" lang="fr">Français<\/a>/, 'the German page links to French and Spanish');
    assert.match(de, /<a href="\/es" hreflang="es" lang="es">Español<\/a>/);
  });

  for (const pg of PAGES) {
    it(`${pg.path} looks right on a computer and a phone, and the form speaks ${pg.lang}`, async (t) => {
      for (const [device, viewport] of [['computer', { width: 1360, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
        const ctx = await browser.newContext({ viewport });
        const p = await ctx.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.goto(P.base + pg.path);
        await p.waitForSelector('#check-form');
        assert.equal(await p.textContent('#check-form button'), pg.button);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `no sideways scrolling on a ${device} (${overflow}px)`);
        if (device === 'computer') {
          await p.click('#check-form button');
          assert.match(await p.textContent('#check-err'), pg.empty, 'empty address: the message is in the page language');
          assert.equal(await p.textContent('#check-form button'), pg.button);
        }
        await screenshot(t, p, `${pg.path} on a ${device}`, { fullPage: device === 'computer' });
        assert.deepEqual(errors, []);
        await ctx.close();
      }
      note(t, `${pg.path}: ${pg.lang} page, form, hreflang, screenshots on a computer and a phone`);
    });
  }

  it('the English home page and its form are unchanged', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(P.base + '/');
    await p.waitForSelector('#check-form');
    await p.click('#check-form button');
    assert.match(await p.textContent('#check-err'), /Enter your store address, like yourstore.com/);
    await ctx.close();
  });
});
