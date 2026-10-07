import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DATA_DIR = new URL('../data/', import.meta.url).pathname;
const SEEN_CAP = 10_000;

mkdirSync(DATA_DIR, { recursive: true });

/**
 * Persisted seen-message-id set per bot — makes /save idempotent so
 * re-delivered messages (module restarts, retries) never duplicate points.
 */
export class SeenIds {
  private ids: Set<string>;
  private order: string[];
  private path: string;

  constructor(bot: string) {
    this.path = `${DATA_DIR}seen-${bot.replace(/[^a-z0-9_-]/gi, '_')}.json`;
    let stored: string[] = [];
    if (existsSync(this.path)) {
      try {
        stored = JSON.parse(readFileSync(this.path, 'utf-8')) as string[];
      } catch {
        stored = [];
      }
    }
    this.order = stored;
    this.ids = new Set(stored);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  addAll(ids: string[]): void {
    for (const id of ids) {
      if (this.ids.has(id)) continue;
      this.ids.add(id);
      this.order.push(id);
    }
    while (this.order.length > SEEN_CAP) {
      const evicted = this.order.shift()!;
      this.ids.delete(evicted);
    }
    try {
      writeFileSync(this.path, JSON.stringify(this.order));
    } catch (err) {
      console.error('[seen] persist failed:', (err as Error).message);
    }
  }

  size(): number {
    return this.ids.size;
  }
}
