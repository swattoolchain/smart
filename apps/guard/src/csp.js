/**
 * Content-Security-Policy for every page we serve: the website, free-check reports, the app and the
 * app inside Shopify admin.
 *
 * Scripts may only come from our own server and a short list of services we use (Shopify App Bridge,
 * Razorpay checkout, Cal.com booking). Inline <script> blocks are allowed one by one by their SHA-256
 * hash, worked out from the page we are about to send, so pages keep their small inline scripts
 * (some carry server data) and cached copies stay valid. Inline event handlers (onclick="…") are not
 * allowed. Styles allow inline style attributes: the app builds many of them, and they cannot run code.
 *
 * CSP_MODE: "enforce", "report-only" (default: browsers report but block nothing) or "off".
 * Production starts in report-only so a page we missed can't break during the App Store review; set
 * CSP_MODE=enforce once /csp-report stays quiet. Tests run with enforce (test/lib/harness.js).
 */
import crypto from 'node:crypto';

const MODE = ['enforce', 'report-only', 'off'].includes(process.env.CSP_MODE) ? process.env.CSP_MODE : 'report-only';
export const cspMode = () => MODE;

/** SHA-256 sources for every inline script (a <script> without src) in the page. */
export function inlineScriptHashes(html) {
  const out = new Set();
  for (const m of String(html).matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] || '')) continue;
    out.add(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return [...out];
}

const SHOPIFY_CDN = 'https://cdn.shopify.com';
const RAZORPAY = { script: ['https://checkout.razorpay.com'], frame: ['https://api.razorpay.com', 'https://checkout.razorpay.com'], connect: ['https://api.razorpay.com', 'https://lumberjack.razorpay.com'] };
const CAL = { script: ['https://app.cal.com'], frame: ['https://app.cal.com', 'https://cal.com'], connect: ['https://app.cal.com'] };

/**
 * The policy for one page.
 * kind: 'embedded' (inside Shopify admin), 'app' (the website app at /app), 'api' (JSON and files: no
 * outside services) or 'site' (everything else).
 * frameAncestors: who may show the page in a frame.
 */
export function policy({ kind = 'site', hashes = [], frameAncestors = "'self'", reportUri = '/csp-report' } = {}) {
  const script = ["'self'", ...hashes];
  const style = ["'self'", "'unsafe-inline'"];
  const connect = ["'self'"];
  const frame = ["'self'"];
  if (kind === 'embedded') {
    script.push(SHOPIFY_CDN);
    style.push(SHOPIFY_CDN);
    connect.push('https://*.shopify.com', 'https://*.shopifysvc.com', 'https://*.shopifycloud.com');
    frame.push('https://admin.shopify.com');
  } else if (kind === 'app') {
    script.push(...RAZORPAY.script);
    connect.push(...RAZORPAY.connect);
    frame.push(...RAZORPAY.frame);
  } else if (kind === 'site') {
    script.push(...CAL.script);
    connect.push(...CAL.connect);
    frame.push(...CAL.frame);
  }
  const d = {
    'default-src': ["'self'"],
    'script-src': script,
    'script-src-attr': ["'none'"],
    'style-src': style,
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': connect,
    'frame-src': frame,
    'media-src': ["'self'", 'blob:', 'data:'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': [frameAncestors],
  };
  return Object.entries(d).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ') + `; report-uri ${reportUri}`;
}

const kindFor = (p) => (p.startsWith('/api/') || p.startsWith('/shopify/api/') ? 'api' : p === '/shopify' || p.startsWith('/shopify/') ? 'embedded' : p === '/app' || p.startsWith('/app/') ? 'app' : 'site');

/**
 * Middleware: every HTML page sent with res.send gets a policy that allows exactly its own inline
 * scripts. Other responses (JSON, files) get the strict policy with no inline scripts.
 * `frameAncestors(req)` gives the frame-ancestors value for the request.
 */
export function cspMiddleware({ frameAncestors }) {
  const header = MODE === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  return (req, res, next) => {
    if (MODE === 'off') {
      // Framing rules still apply when the policy is switched off.
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors(req)}`);
      return next();
    }
    const kind = kindFor(req.path);
    const base = { kind, frameAncestors: frameAncestors(req) };
    res.setHeader(header, policy(base));
    // Framing is always enforced, also in report-only mode.
    if (MODE === 'report-only') res.setHeader('Content-Security-Policy', `frame-ancestors ${base.frameAncestors}`);
    const send = res.send.bind(res);
    res.send = (body) => {
      if (typeof body === 'string' && /html/i.test(String(res.get('Content-Type') || '')) && /<script/i.test(body)) {
        res.setHeader(header, policy({ ...base, hashes: inlineScriptHashes(body) }));
      }
      return send(body);
    };
    next();
  };
}

/** Browsers post policy violations here; we log a short line (at most 60 a minute). */
export function cspReportRoute(app, express) {
  let windowStart = 0, count = 0;
  app.post('/csp-report', express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }), (req, res) => {
    const now = Date.now();
    if (now - windowStart > 60e3) { windowStart = now; count = 0; }
    if (++count <= 60) {
      const r = req.body?.['csp-report'] || (Array.isArray(req.body) ? req.body[0]?.body : req.body) || {};
      const s = (v) => String(v ?? '').slice(0, 200).replace(/[\r\n]/g, ' ');
      console.warn('csp violation', s(r['violated-directive'] || r.effectiveDirective), s(r['blocked-uri'] || r.blockedURL), 'on', s(r['document-uri'] || r.documentURL));
    }
    res.status(204).end();
  });
}
