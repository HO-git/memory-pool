import { watch } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ServiceConfig, BotConfig } from './types.ts';

const CONFIG_PATH = new URL('../config.json', import.meta.url).pathname;

let current: ServiceConfig = load();
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function load(): ServiceConfig {
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ServiceConfig;
  migrate(parsed);
  validate(parsed);
  return parsed;
}

/** Older configs called `recall` `enabled`. Read it, and write `recall` from then on. */
export function migrate(cfg: ServiceConfig): void {
  for (const bot of Object.values(cfg.bots ?? {})) {
    const legacy = bot as BotConfig & { enabled?: unknown };
    if (legacy.recall === undefined && typeof legacy.enabled === 'boolean') legacy.recall = legacy.enabled;
    delete legacy.enabled;
  }
}

export function validate(cfg: ServiceConfig): void {
  if (typeof cfg.global?.paused !== 'boolean') throw new Error('global.paused must be boolean');
  if (typeof cfg.global?.debug !== 'boolean') throw new Error('global.debug must be boolean');
  if (!cfg.bots || typeof cfg.bots !== 'object') throw new Error('bots must be an object');
  for (const [name, bot] of Object.entries(cfg.bots)) {
    for (const key of ['collection', 'embeddingModel', 'selfSpeaker'] as const) {
      if (typeof bot[key] !== 'string' || !bot[key]) throw new Error(`bots.${name}.${key} must be a non-empty string`);
    }
    for (const key of [
      'embeddingDimensions', 'memoryLimit', 'scoreThreshold', 'minMessageLength',
      'chunkMinSize', 'chunkMaxSize', 'chunkTimeoutMs',
    ] as const) {
      if (typeof bot[key] !== 'number' || !(bot[key] >= 0)) throw new Error(`bots.${name}.${key} must be a non-negative number`);
    }
    if (typeof bot.recall !== 'boolean' || typeof bot.autoSave !== 'boolean') {
      throw new Error(`bots.${name}.recall/autoSave must be boolean`);
    }
    if (!bot.speakerAliases || typeof bot.speakerAliases !== 'object') {
      throw new Error(`bots.${name}.speakerAliases must be an object`);
    }
  }
}

export function getConfig(): ServiceConfig {
  return current;
}

export function getBot(name: string): BotConfig | null {
  const bot = current.bots[name];
  return bot ?? null;
}

export function saveConfig(next: ServiceConfig): void {
  migrate(next);
  validate(next);
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  current = next;
}

/** Watch config.json for external edits (hot reload, debounced). */
export function watchConfig(onReload: (cfg: ServiceConfig) => void): void {
  watch(CONFIG_PATH, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        current = load();
        onReload(current);
      } catch (err) {
        console.error('[config] reload failed, keeping previous config:', (err as Error).message);
      }
    }, 500);
  });
}
