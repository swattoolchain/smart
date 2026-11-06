// Prospect checker: a light, polite check of public Shopify stores, for go-to-market research.
// Not part of the product. See src/prospect.js for the hard limits it keeps.
//
// Usage: node scripts/prospect-check.js stores.csv [findings.csv]
//   stores.csv: one store address per line, or a CSV with a url/store/domain/website column.
//   findings.csv: written as each store finishes (default: prospect-findings-<date>.csv).
import fs from 'node:fs';
import { checkStores, readStoreList, toCsv, COLUMNS, MAX_CONCURRENCY } from '../src/prospect.js';

const [input, output = `prospect-findings-${new Date().toISOString().slice(0, 10)}.csv`] = process.argv.slice(2);
if (!input) { console.error('Usage: node scripts/prospect-check.js stores.csv [findings.csv]'); process.exit(1); }
const stores = readStoreList(fs.readFileSync(input, 'utf8'));
if (!stores.length) { console.error(`No store addresses found in ${input}`); process.exit(1); }
console.log(`Checking ${stores.length} stores, ${MAX_CONCURRENCY} at a time. Findings go to ${output}.`);

fs.writeFileSync(output, COLUMNS.join(',') + '\n');
let done = 0;
await checkStores(stores, {
  onResult: (r) => {
    fs.appendFileSync(output, toCsv([r]).split('\n').slice(1).join('\n'));
    done++;
    console.log(`[${done}/${stores.length}] ${r.store}: ${r.status}${r.findings.length ? ' – ' + r.findings.join('; ') : ''}`);
  },
});
console.log(`Done. ${output}`);
