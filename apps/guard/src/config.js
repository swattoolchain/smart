import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  sessionSecret: process.env.SESSION_SECRET || (process.env.BASE_URL?.startsWith('https://') ? (() => { throw new Error('SESSION_SECRET must be set in production'); })() : 'dev-only-change-me'),
  chromePath: process.env.CHROME_PATH || undefined,
  // Optional outbound proxy for the test browser, e.g. http://user:pass@proxy:port (helps with strict bot protection).
  browserProxy: process.env.BROWSER_PROXY || '',
  serverIp: process.env.SERVER_IP || '',
  // AI review. Anthropic by default; any OpenAI-compatible API works via AI_PROVIDER=openai + AI_BASE_URL.
  ai: {
    provider: process.env.AI_PROVIDER || 'anthropic',
    key: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || '',
    textModel: process.env.AI_TEXT_MODEL || 'claude-haiku-5-5',
    visionModel: process.env.AI_VISION_MODEL || 'claude-haiku-5-5',
    explainModel: process.env.AI_EXPLAIN_MODEL || 'claude-sonnet-5-5',
    visionCapable: process.env.AI_VISION !== '0',
  },
  concurrency: Number(process.env.RUN_CONCURRENCY || 2),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Tharam Store Guard <alerts@tharam.store>',
  },
  adminEmail: process.env.ADMIN_EMAIL || '',
  // Shopify app (embedded in Shopify admin). Empty values switch the Shopify app off.
  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY || '',
    apiSecret: process.env.SHOPIFY_API_SECRET || '',
    appHandle: process.env.SHOPIFY_APP_HANDLE || 'tharam',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-10',
    // Lets tests point token exchange and GraphQL at a local fake Shopify.
    adminBase: process.env.SHOPIFY_ADMIN_BASE || '',
    // Only for our own testing: let Shopify test charges unlock plans on any store.
    allowTestCharges: process.env.SHOPIFY_ALLOW_TEST_CHARGES === '1',
  },
  // Online payments on the website (Razorpay). Empty values mean customers pay by invoice instead.
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com',
  },
  // Encrypts stored Shopify tokens. Falls back to a key derived from SESSION_SECRET.
  tokenKey: process.env.TOKEN_KEY || '',
  // Cal.com booking link, e.g. "tharam/demo" or a full https://cal.com/... URL.
  calLink: (process.env.CAL_LINK || '').replace(/^https?:\/\/(app\.)?cal\.com\//, ''),
  contactEmail: process.env.CONTACT_EMAIL || 'hello@tharam.store',
  // How often monitored stores are checked (minutes). Free beta default: every 3 hours.
  journeyIntervalMin: Number(process.env.JOURNEY_INTERVAL_MIN || 180),
  fullScanIntervalMin: Number(process.env.FULL_SCAN_INTERVAL_MIN || 1440),
  freeScansPerIpPerHour: Number(process.env.FREE_SCANS_PER_IP_PER_HOUR || 3),
  userAgent:
    process.env.GUARD_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36 TharamStoreGuard/0.1 (+https://tharam.store/bot)',
};
