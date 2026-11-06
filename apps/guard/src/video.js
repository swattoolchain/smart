/**
 * Video replay of failed shopping journeys (roadmap 7).
 * When a store has it switched on, the shopping journey is recorded; the video is kept only if a journey
 * check failed, next to the run's screenshots (so it is served to the store owner only, like screenshots),
 * and deleted after 7 days.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const VIDEO_FILE = 'journey-video.webm';
export const VIDEO_DAYS = 7;

/** Deletes replay videos older than `days`. Returns how many were removed. */
export function pruneVideos({ days = VIDEO_DAYS, now = Date.now() } = {}) {
  const dir = path.join(config.dataDir, 'shots');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, VIDEO_FILE);
    try {
      if (now - fs.statSync(f).mtimeMs > days * 86400e3) { fs.rmSync(f, { force: true }); n++; }
    } catch {}
  }
  // Recordings left behind by a run that was interrupted (server restart).
  for (const d of fs.readdirSync(config.dataDir).filter((x) => x.startsWith('video-tmp-'))) {
    const f = path.join(config.dataDir, d);
    try { if (now - fs.statSync(f).mtimeMs > 86400e3) fs.rmSync(f, { recursive: true, force: true }); } catch {}
  }
  return n;
}
