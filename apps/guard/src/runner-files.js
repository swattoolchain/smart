/**
 * Files a full check needs that live on the main server, and the ones it makes, for checks run on a worker.
 *
 *   in   the store's approved visual baselines (data/baselines/store-N/*.png) and the latest catalog snapshot
 *        from before this check (data/catalog/store-N/run-M.json), fetched by the worker before it starts
 *   out  first baselines (only when the store has none for that view yet: the same rule as a check on the main
 *        server, so a worker can never replace an approved look) and this check's catalog snapshot
 *
 * Approving a new look is unchanged: it copies the check's screenshots (already on the main server) to the baseline.
 * Nothing here is reachable by store owners; the worker routes check that the worker holds the check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { snapshotRuns } from './engine/catalog-check.js';

const PNG_NAME = /^[\w-]{1,60}\.png$/;
const baselineDir = (storeId) => path.join(config.dataDir, 'baselines', `store-${Number(storeId)}`);
const catalogDir = (storeId) => path.join(config.dataDir, 'catalog', `store-${Number(storeId)}`);

/** What the worker should fetch for this full check. */
export function fullCheckInputs(storeId, runId) {
  const dir = baselineDir(storeId);
  const baselines = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => PNG_NAME.test(f) && !f.endsWith('-diff.png')).sort() : [];
  const catalogPrev = snapshotRuns(storeId).find((r) => r < runId) || null;
  return { baselines, catalogPrev };
}

/** A baseline image, or null. */
export function readBaseline(storeId, file) {
  if (!PNG_NAME.test(file)) return null;
  const f = path.join(baselineDir(storeId), file);
  return fs.existsSync(f) ? f : null;
}

/** The catalog snapshot this check compares with (the latest one before it), as text, or null. */
export function readPreviousCatalog(storeId, runId) {
  const prev = snapshotRuns(storeId).find((r) => r < runId);
  if (!prev) return null;
  return { runId: prev, text: fs.readFileSync(path.join(catalogDir(storeId), `run-${prev}.json`), 'utf8') };
}

const isPng = (b) => Buffer.isBuffer(b) && b.length >= 8 && b.readUInt32BE(0) === 0x89504e47;

/**
 * A first baseline from a worker. Saved only if the store has no baseline for this view yet.
 * Returns 'saved', 'kept' (an approved baseline exists and stays) or an error string.
 */
export function saveFirstBaseline(storeId, file, body) {
  if (!PNG_NAME.test(file) || file.endsWith('-diff.png')) return 'Bad file name';
  if (!isPng(body)) return 'Not a PNG image';
  const dir = baselineDir(storeId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, file), body, { flag: 'wx' }); // never overwrites
    return 'saved';
  } catch (e) {
    if (e.code === 'EEXIST') return 'kept';
    throw e;
  }
}

/** This check's catalog snapshot from a worker. */
export function saveCatalogSnapshot(storeId, runId, snap) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.products) || typeof snap.count !== 'number') return 'Send a catalog snapshot with products';
  fs.mkdirSync(catalogDir(storeId), { recursive: true });
  fs.writeFileSync(path.join(catalogDir(storeId), `run-${Number(runId)}.json`), JSON.stringify(snap));
  return 'saved';
}
