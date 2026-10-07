import { appendFileSync, mkdirSync } from 'node:fs';
import type { ActivityEntry } from './types.ts';

const DATA_DIR = new URL('../data/', import.meta.url).pathname;
const LOG_PATH = `${DATA_DIR}activity.jsonl`;
const RING_MAX = 300;

const ring: ActivityEntry[] = [];
mkdirSync(DATA_DIR, { recursive: true });

export function logActivity(entry: Omit<ActivityEntry, 'ts'>): void {
  const full: ActivityEntry = { ts: Date.now(), ...entry };
  ring.push(full);
  if (ring.length > RING_MAX) ring.shift();
  try {
    appendFileSync(LOG_PATH, JSON.stringify(full) + '\n');
  } catch (err) {
    console.error('[activity] failed to append log:', (err as Error).message);
  }
  if (entry.kind === 'error') console.error(`[${entry.kind}]`, entry.bot ?? '', entry.detail);
}

export function recentActivity(limit = 100): ActivityEntry[] {
  return ring.slice(-limit).reverse();
}
