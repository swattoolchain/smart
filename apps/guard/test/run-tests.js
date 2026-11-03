// End-to-end engine tests against the mock store: healthy store must pass, each breakage must be caught.
// Usage: CHROME_PATH=/path/to/chrome npm test   (inside Docker no CHROME_PATH is needed)
import { spawn } from 'node:child_process';
import { runScan } from '../src/engine/index.js';
import { getBrowser } from '../src/engine/browser.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
const cases = [
  { break: '', expect: (r) => r.verdict !== 'critical' && r.checks.find((c) => c.id === 'fn.checkout')?.status === 'pass' },
  { break: 'atc', expect: (r) => r.checks.find((c) => c.id === 'fn.atc')?.status === 'fail' },
  { break: 'checkout', expect: (r) => r.checks.find((c) => c.id === 'fn.checkout')?.status === 'fail' },
  { break: 'search', expect: (r) => r.checks.find((c) => c.id === 'fn.search')?.status === 'fail' },
  { break: 'jserror', expect: (r) => r.checks.find((c) => c.id === 'nf.jserrors')?.status !== 'pass' },
  { break: 'password', expect: (r) => r.verdict === 'locked' },
  { break: 'password', password: 'letmein', expect: (r) => r.checks.find((c) => c.id === 'fn.atc')?.status === 'pass' },
];

let failed = 0;
for (const [i, c] of cases.entries()) {
  const port = 4200 + i;
  const proc = spawn(process.execPath, ['test/mock-store.js'], { env: { ...process.env, MOCK_PORT: String(port), MOCK_BREAK: c.break }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const r = await runScan({ runId: `test-${i}`, origin: `http://localhost:${port}`, kind: 'journeys', password: c.password });
  const ok = c.expect(r);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  break=${c.break || 'none'}${c.password ? ' (with password)' : ''}  verdict=${r.verdict}`);
  proc.kill();
}
(await getBrowser()).close();
console.log(failed ? `${failed} test(s) failed` : 'All engine tests passed');
process.exit(failed ? 1 : 0);
