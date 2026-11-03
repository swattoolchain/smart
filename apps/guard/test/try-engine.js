// Quick manual run: node test/try-engine.js http://localhost:4100 [kind] [password]
import { runScan } from '../src/engine/index.js';

const [, , origin = 'http://localhost:4100', kind = 'full', password] = process.argv;
const r = await runScan({ runId: `try-${Date.now()}`, origin, kind, password, storeId: 'try' });
for (const c of r.checks) console.log(`${c.status.padEnd(4)} ${c.severity.padEnd(8)} ${c.id.padEnd(24)} ${c.detail}`);
console.log(`\nSCORE ${r.score} ${r.verdict} — ${r.summary} (${(r.durationMs / 1000).toFixed(1)}s)`);
if (r.error) console.log('ERROR', r.error);
process.exit(0);
