// The WordPress plugin zip, built from src/wp-plugin/tharam-store-guard when asked (no extra packages).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wp-plugin');
export const PLUGIN_SLUG = 'tharam-store-guard';
export const ZIP_NAME = `${PLUGIN_SLUG}.zip`;

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A zip with fixed timestamps, so the same files always give the same bytes. */
export function makeZip(entries) {
  const parts = []; const central = []; let offset = 0;
  const DOS_TIME = 0; const DOS_DATE = (46 << 9) | (1 << 5) | 1; // 2026-01-01
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name); const deflated = zlib.deflateRawSync(data, { level: 9 }); const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(deflated.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(0x81a40000, 38); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

let cached;
export function pluginFiles() {
  const base = path.join(DIR, PLUGIN_SLUG);
  return fs.readdirSync(base).filter((f) => fs.statSync(path.join(base, f)).isFile()).sort()
    .map((f) => ({ name: `${PLUGIN_SLUG}/${f}`, data: fs.readFileSync(path.join(base, f)) }));
}
export const pluginVersion = () => /^\s*\*\s*Version:\s*(\S+)/m.exec(pluginFiles().find((f) => f.name.endsWith('.php')).data.toString())?.[1] || '0';
export function pluginZip() { return (cached ||= makeZip(pluginFiles())); }

export function pluginRoutes(app) {
  app.get(`/downloads/${ZIP_NAME}`, (req, res) => {
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${ZIP_NAME}"`, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(pluginZip());
  });
}
