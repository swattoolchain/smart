import fs from 'node:fs';
import path from 'node:path';
import { check, shortErr, plural } from './checks.js';
import { reviewScreenshot } from '../ai.js';

const PAGE = { home: 'homepage', product: 'product page' };

/** AI reviews the full-check screenshots like a QA tester looking for anything a shopper would notice. */
export async function reviewScreens({ runDir, origin, rec }) {
  const out = { findings: [], reviewed: 0 };
  // One desktop and one mobile per page type is enough to catch layout and content problems cheaply.
  const targets = ['home-desktop', 'home-mobile', 'product-desktop', 'product-mobile'];
  for (const key of targets) {
    const file = path.join(runDir, `${key}.png`);
    if (!fs.existsSync(file)) continue;
    const [p, device] = key.split('-');
    try {
      const r = await reviewScreenshot(file, { page: PAGE[p] || p, device, url: new URL(origin).host });
      out.reviewed++;
      for (const f of r.findings) out.findings.push({ ...f, page: PAGE[p] || p, device, shot: `/shots/${path.basename(runDir)}/${key}.png` });
    } catch (e) {
      out.error = shortErr(e);
    }
  }
  const serious = out.findings.filter((f) => f.severity === 'critical' || f.severity === 'major');
  rec.add(
    check('ai.visual', 'reliability', 'Pages look right to a human (AI review)', out.reviewed === 0 ? 'skip' : out.findings.some((f) => f.severity === 'critical') ? 'fail' : serious.length ? 'warn' : 'pass', {
      severity: 'major',
      detail:
        out.reviewed === 0
          ? `AI review did not run${out.error ? `: ${out.error}` : ''}.`
          : out.findings.length
            ? `AI spotted ${plural(out.findings.length, 'issue')} a shopper would notice: ${out.findings.slice(0, 3).map((f) => `${f.issue} (${f.page}, ${f.device})`).join('; ')}.`
            : `AI reviewed ${out.reviewed} screenshots across desktop and mobile; nothing looked wrong.`,
      evidence: out.findings.length ? { ai: out.findings.slice(0, 20) } : null,
      fix: out.findings.length ? 'Each finding points to a page and device. Open the Reports section to see the screenshots.' : '',
    })
  );
  return out;
}
