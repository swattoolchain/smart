/** Removes every file Tharam keeps for a store: screenshots of all its runs, approved looks, product snapshots. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

export function purgeStoreFiles(storeId) {
  const id = Number(storeId);
  if (!Number.isInteger(id) || id <= 0) return;
  for (const r of db.prepare('SELECT id FROM runs WHERE store_id = ?').all(id)) fs.rmSync(path.join(config.dataDir, 'shots', `run-${r.id}`), { recursive: true, force: true });
  for (const dir of ['baselines', 'catalog']) fs.rmSync(path.join(config.dataDir, dir, `store-${id}`), { recursive: true, force: true });
}
