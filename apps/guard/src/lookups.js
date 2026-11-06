/**
 * Looking at a store before it is added (or again from Store settings) opens a real browser, like a check.
 * These lookups share a small pool: a few at a time across everyone, one at a time per account, and a short
 * waiting line. Past that, people get a plain "busy" answer instead of the server piling up browsers.
 */
import { config } from './config.js';

export const BUSY = 'We’re very busy right now. Try again in a few minutes.';
export class Busy extends Error {
  constructor(message = BUSY, status = 503) { super(message); this.code = 'QUEUE_FULL'; this.status = status; }
}

let active = 0;
const waiters = [];
const inFlight = new Set();

/** Runs `fn` when a lookup slot is free. `key` is the account: one lookup per account at a time. */
export async function withLookupSlot(key, fn) {
  if (inFlight.has(key)) throw new Busy('We’re already looking at a store for you. Wait for it to finish, then try again.', 429);
  inFlight.add(key);
  try {
    if (active >= config.lookupConcurrency) {
      if (waiters.length >= config.lookupQueueMax) throw new Busy();
      await new Promise((resolve, reject) => {
        const w = { resolve };
        w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Busy()); }, config.lookupWaitMs);
        waiters.push(w);
      });
      // Woken by a finished lookup: its slot was handed to us, so `active` already counts this one.
    } else active++;
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) { clearTimeout(next.timer); next.resolve(); } else active--;
    }
  } finally {
    inFlight.delete(key);
  }
}

export const lookupLoad = () => ({ active, waiting: waiters.length });
