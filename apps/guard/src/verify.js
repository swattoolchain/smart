/**
 * Runs the journey suite against a list of real Shopify stores to measure false alarms.
 * Usage: node src/verify.js [stores.txt]   (one URL per line; defaults to a built-in list)
 * Runs one store at a time with a pause between stores, so it behaves like a single shopper.
 * Output: a summary table, plus verify-report.json to paste back for tuning.
 */
import fs from 'node:fs';
import { runScan } from './engine/index.js';
import { getBrowser } from './engine/browser.js';

const DEFAULT = [
  'allbirds.com', 'gymshark.com', 'colourpop.com', 'bombas.com', 'brooklinen.com', 'ruggable.com',
  'deathwishcoffee.com', 'rothys.com', 'chubbiesshorts.com', 'kyliecosmetics.com', 'mvmt.com', 'outdoorvoices.com',
  'snitch.co.in', 'boat-lifestyle.com', 'bombayshavingcompany.com', 'mcaffeine.com', 'libas.in', 'suta.in',
  'sugarcosmetics.com', 'thewholetruthfoods.com', 'bluetokaicoffee.com', 'pilgrim.in', 'nicobar.com', 'theayurvedaexperience.com',
];

const file = process.argv[2];
const stores = file ? fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean) : DEFAULT;
const kind = process.env.VERIFY_KIND || 'journeys';
const out = [];

for (const s of stores) {
  const origin = /^https?:\/\//.test(s) ? s.replace(/\/$/, '') : `https://${s}`;
  process.stdout.write(`${origin.padEnd(40)} `);
  const t0 = Date.now();
  try {
    const r = await runScan({ runId: `verify-${Date.now()}`, origin, kind });
    const bad = r.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
    console.log(`${String(r.score).padStart(4)} ${String(r.verdict).padEnd(9)} ${Math.round((Date.now() - t0) / 1000)}s  ${bad.map((c) => `${c.status}:${c.id}`).join(' ')}`);
    out.push({ origin, score: r.score, verdict: r.verdict, issues: bad.map(({ id, status, severity, detail, evidence }) => ({ id, status, severity, detail, selector: evidence?.selector })), error: r.error });
  } catch (e) {
    console.log(`ERROR ${e.message}`);
    out.push({ origin, error: e.message });
  }
  await new Promise((r) => setTimeout(r, 5000));
}

fs.writeFileSync('verify-report.json', JSON.stringify(out, null, 2));
const critical = out.filter((o) => o.verdict === 'critical');
console.log(`\n${out.length} stores, ${critical.length} flagged critical: ${critical.map((c) => c.origin).join(', ') || 'none'}`);
console.log('Open the critical ones in a browser: if they actually work, those are false alarms to tune. Report saved to verify-report.json');
(await getBrowser()).close();
process.exit(0);
