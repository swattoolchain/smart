/**
 * Keeps the test browser on the public internet.
 *
 * Every request Chromium makes (pages, redirects, images, scripts, fetches, WebSockets, Playwright's
 * context.request) goes through this small local proxy. It resolves the destination itself, at the moment
 * it connects, and refuses private, loopback, link-local and other internal addresses. Because the proxy
 * connects to the exact address it checked, a redirect to an internal address or a DNS answer that changes
 * after the first check (rebinding) is refused too.
 *
 * ALLOW_LOCAL_TARGETS=1 (tests and local development) lets everything through.
 */
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(a, p, 'ipv6');

/** True for any address that is not a normal public internet address (IPv4-mapped IPv6 included). */
export function isPrivateIp(ip) {
  let a = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!net.isIP(a)) return true;
  // ::ffff:1.2.3.4 and ::ffff:0102:0304 are IPv4 addresses in IPv6 clothing.
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(a) || /^::ffff:(.+)$/.exec(a);
  if (mapped && net.isIPv6(a)) {
    const tail = mapped[1];
    if (net.isIPv4(tail)) a = tail;
    else {
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
      if (m) { const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16); a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
    }
  }
  return blocked.check(a, net.isIPv4(a) ? 'ipv4' : 'ipv6');
}

const allowLocal = () => process.env.ALLOW_LOCAL_TARGETS === '1';
// Testing only: addresses the filter treats as public (lets a test stand in for an outside store on 127.0.0.2).
const testAllowed = (h) => (process.env.EGRESS_TEST_ALLOW || '').split(',').filter(Boolean).includes(h);

/** Resolves a host to one address that is safe to connect to, or throws with a plain reason. */
export async function resolvePublic(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  // localhost and *.localhost always mean this machine (browsers resolve them so themselves; Node's resolver may not):
  // they become 127.0.0.1 and are refused below like any other internal address.
  const loopbackName = /^(?:.+\.)?localhost\.?$/i.test(h);
  const addrs = net.isIP(h) ? [{ address: h }] : loopbackName ? [{ address: '127.0.0.1' }] : await dns.lookup(h, { all: true, verbatim: true });
  if (!addrs.length) throw new Error(`${host} has no address`);
  if (allowLocal() || testAllowed(h)) return addrs[0].address;
  if (addrs.some((x) => isPrivateIp(x.address))) {
    const e = new Error(`${host} points to a private network address`);
    e.private = true;
    throw e;
  }
  return addrs[0].address;
}

const refusals = []; // recent refused destinations, newest last (for logs and tests)
const note = (host, why) => { refusals.push({ host, why, at: Date.now() }); if (refusals.length > 200) refusals.shift(); };
export const recentRefusals = () => refusals.slice();

const REFUSED_BODY = (host) => `<!doctype html><title>Blocked</title><p>Tharam did not open ${String(host).replace(/[<>&"]/g, '')}: it points to a private network address, which the test browser never visits.</p>`;

let started = null;
/** Starts the proxy once and returns its address (http://127.0.0.1:port). */
export function startEgressProxy() {
  if (started) return started;
  started = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // Browsers drop connections all the time; a reset must never take the app down.
      req.on('error', () => {});
      res.on('error', () => {});
      // Plain http:// requests arrive with an absolute URL.
      let u;
      try { u = new URL(req.url); } catch { res.writeHead(400).end(); return; }
      let ip;
      try { ip = await resolvePublic(u.hostname); } catch (e) {
        note(u.hostname, e.message);
        res.writeHead(e.private ? 403 : 502, { 'Content-Type': 'text/html; charset=utf-8', 'X-Tharam-Blocked': '1' }).end(e.private ? REFUSED_BODY(u.hostname) : 'Could not reach the site');
        return;
      }
      const headers = { ...req.headers, host: u.host };
      delete headers['proxy-connection'];
      const up = http.request({ host: ip, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers, setHost: false }, (r) => {
        r.on('error', () => res.destroy());
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      req.pipe(up);
    });
    // https:// and wss:// arrive as CONNECT host:port tunnels.
    server.on('connect', async (req, socket, head) => {
      socket.on('error', () => {});
      const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
      if (!m) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      const [, host, port] = m;
      let ip;
      try { ip = await resolvePublic(host); } catch (e) {
        note(host, e.message);
        socket.end(`HTTP/1.1 ${e.private ? '403 Forbidden' : '502 Bad Gateway'}\r\nX-Tharam-Blocked: 1\r\n\r\n`);
        return;
      }
      const up = net.connect(Number(port), ip, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
      socket.on('close', () => up.destroy());
    });
    server.on('clientError', (err, socket) => socket.destroy());
    server.on('connection', (sock) => sock.on('error', () => {}));
    server.listen(0, '127.0.0.1', () => { server.unref(); resolve(`http://127.0.0.1:${server.address().port}`); });
    server.on('error', reject);
  });
  return started;
}
