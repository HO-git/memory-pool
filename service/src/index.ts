import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getConfig, getBot, saveConfig, watchConfig } from './config.ts';
import type { RetrieveRequest, SaveRequest, ServiceConfig } from './types.ts';
import { retrieve } from './retrieve.ts';
import { BotChunker } from './chunker.ts';
import { logActivity, recentActivity } from './activity.ts';
import {
  countPoints, deletePoolPoints, deletePointsByIds, listCollections,
  ping, qdrantUrl, scrollPoints, snapshotCollection,
} from './qdrant.ts';
import { embeddingsProvider } from './embeddings.ts';

const BIND = process.env.BIND || '127.0.0.1';
const PORT = Number(process.env.PORT || 3102);
const UI_USER = process.env.UI_USER || '';
const UI_PASSWORD = process.env.UI_PASSWORD || '';
const UI_HTML_PATH = new URL('../ui/index.html', import.meta.url).pathname;

const chunkers = new Map<string, BotChunker>();
function chunkerFor(bot: string): BotChunker {
  let c = chunkers.get(bot);
  if (!c) {
    c = new BotChunker(bot, () => {
      const cfg = getBot(bot);
      if (!cfg) throw new Error(`bot ${bot} removed from config`);
      return cfg;
    });
    chunkers.set(bot, c);
  }
  return c;
}

watchConfig(() => logActivity({ kind: 'admin', detail: 'config reloaded from disk' }));
// Restore accepted pending saves immediately, even before the next chat request.
for (const name of Object.keys(getConfig().bots)) chunkerFor(name);

/** `pool` (memory-pool points) or `st` (SillyTavern points); `discord` is the older name for `pool`. */
function originParam(value: string | null): 'pool' | 'st' | null {
  if (value === 'pool' || value === 'discord') return 'pool';
  if (value === 'st') return 'st';
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkAuth(req: Request): boolean {
  if (!UI_USER || !UI_PASSWORD) return false;
  const header = req.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  } catch {
    return false;
  }
  const expected = Buffer.from(`${UI_USER}:${UI_PASSWORD}`);
  const got = Buffer.from(decoded);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="memory-pool"' },
  });
}

async function handleRetrieve(req: Request): Promise<Response> {
  const body = (await req.json()) as RetrieveRequest;
  const cfg = getBot(body.bot ?? '');
  if (!cfg) return json({ error: `unknown bot: ${body.bot}` }, 404);
  if (!body.query_text || typeof body.query_text !== 'string') {
    return json({ error: 'query_text required' }, 400);
  }
  if (getConfig().global.paused || !cfg.recall) {
    logActivity({ kind: 'retrieve', bot: body.bot, detail: `skipped (${getConfig().global.paused ? 'paused' : 'recall off'})` });
    return json({ formatted: '', hits: [], count: 0, skipped: true });
  }
  try {
    const result = await retrieve(cfg, body.query_text, body.exclude_message_ids ?? [], body.limit);
    logActivity({
      kind: 'retrieve',
      bot: body.bot,
      detail: `query "${body.query_text.slice(0, 120)}" → ${result.count} hit(s)`,
      data: {
        scores: result.hits.map(h => Number(h.score.toFixed(3))),
        excluded: (body.exclude_message_ids ?? []).length,
        returned: result.formatted || undefined,
      },
    });
    return json(result);
  } catch (err) {
    // Fail open: the caller gets no memories and carries on.
    logActivity({ kind: 'error', bot: body.bot, detail: `retrieve failed: ${(err as Error).message}` });
    return json({ formatted: '', hits: [], count: 0, error: (err as Error).message });
  }
}

async function handleSave(req: Request): Promise<Response> {
  const body = (await req.json()) as SaveRequest;
  const cfg = getBot(body.bot ?? '');
  if (!cfg) return json({ error: `unknown bot: ${body.bot}` }, 404);
  if (!Array.isArray(body.messages)) return json({ error: 'messages[] required' }, 400);
  // `autoSave` alone gates saving — deliberately independent of `recall`
  // (which gates retrieval), so the toggles compose into an archive-only
  // mode: recall off + auto-save on = conversations saved, never read back.
  if (getConfig().global.paused || !cfg.autoSave) {
    logActivity({ kind: 'save', bot: body.bot, detail: `skipped ${body.messages.length} msg(s) (paused/autoSave off)` });
    return json({ buffered: 0, skipped: true });
  }
  try {
    const source = typeof body.source === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(body.source) ? body.source : 'discord';
    const buffered = chunkerFor(body.bot).accept(body.messages, source);
    if (getConfig().global.debug) {
      logActivity({ kind: 'save', bot: body.bot, detail: `buffered ${buffered}/${body.messages.length} msg(s)` });
    }
    return json({ buffered });
  } catch (err) {
    logActivity({ kind: 'error', bot: body.bot, detail: `save failed: ${(err as Error).message}` });
    return json({ buffered: 0, error: (err as Error).message });
  }
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/status' && req.method === 'GET') {
    const cfg = getConfig();
    return json({
      qdrant: { url: qdrantUrl(), reachable: await ping() },
      embeddings: { provider: embeddingsProvider() },
      paused: cfg.global.paused,
      debug: cfg.global.debug,
      bots: Object.fromEntries(
        Object.entries(cfg.bots).map(([name, bot]) => [name, {
          recall: bot.recall,
          autoSave: bot.autoSave,
          collection: bot.collection,
          buffered: chunkers.get(name)?.bufferedCount() ?? 0,
          pending: chunkers.get(name)?.pendingCount() ?? 0,
          seenIds: chunkers.get(name)?.seen.size() ?? 0,
        }]),
      ),
    });
  }

  if (path === '/api/config' && req.method === 'GET') return json(getConfig());

  if (path === '/api/config' && req.method === 'PUT') {
    const next = (await req.json()) as ServiceConfig;
    try {
      saveConfig(next);
      logActivity({ kind: 'admin', detail: 'config updated via UI' });
      return json({ ok: true });
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
  }

  if (path === '/api/collections' && req.method === 'GET') {
    try {
      return json(await listCollections());
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (path === '/api/points' && req.method === 'GET') {
    const bot = url.searchParams.get('bot') ?? '';
    const cfg = getBot(bot);
    if (!cfg) return json({ error: `unknown bot: ${bot}` }, 404);
    const source = originParam(url.searchParams.get('source'));
    const offsetRaw = url.searchParams.get('offset');
    try {
      const { points, nextOffset } = await scrollPoints(cfg.collection, {
        limit: Number(url.searchParams.get('limit') || 20),
        offset: offsetRaw || null,
        source,
      });
      const counts = {
        total: await countPoints(cfg.collection),
        pool: await countPoints(cfg.collection, 'pool'),
      };
      return json({ points, nextOffset, counts });
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (path === '/api/search' && req.method === 'POST') {
    const body = (await req.json()) as { bot: string; query: string; limit?: number };
    const cfg = getBot(body.bot ?? '');
    if (!cfg) return json({ error: `unknown bot: ${body.bot}` }, 404);
    try {
      return json(await retrieve(cfg, body.query ?? '', [], body.limit ?? 10));
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (path === '/api/points/delete' && req.method === 'POST') {
    const body = (await req.json()) as { bot: string; ids?: Array<string | number>; source?: string };
    const cfg = getBot(body.bot ?? '');
    if (!cfg) return json({ error: `unknown bot: ${body.bot}` }, 404);
    try {
      if (originParam(body.source ?? null) === 'pool') {
        const before = await countPoints(cfg.collection, 'pool');
        await deletePoolPoints(cfg.collection);
        logActivity({ kind: 'admin', bot: body.bot, detail: `bulk-deleted ${before} memory-pool point(s) from ${cfg.collection}` });
        return json({ deleted: before });
      }
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        await deletePointsByIds(cfg.collection, body.ids);
        logActivity({ kind: 'admin', bot: body.bot, detail: `deleted ${body.ids.length} point(s) from ${cfg.collection}` });
        return json({ deleted: body.ids.length });
      }
      return json({ error: 'provide ids[] or source:"pool"' }, 400);
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (path === '/api/snapshot' && req.method === 'POST') {
    const body = (await req.json()) as { bot: string };
    const cfg = getBot(body.bot ?? '');
    if (!cfg) return json({ error: `unknown bot: ${body.bot}` }, 404);
    try {
      const name = await snapshotCollection(cfg.collection);
      logActivity({ kind: 'admin', bot: body.bot, detail: `snapshot created: ${name} (${cfg.collection})` });
      return json({ snapshot: name });
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (path === '/api/activity' && req.method === 'GET') {
    return json(recentActivity(Number(url.searchParams.get('limit') || 100)));
  }

  return json({ error: 'not found' }, 404);
}

const server = Bun.serve({
  hostname: BIND,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/healthz') return json({ ok: true });
      // Service endpoints for the framework hooks — loopback-bound, no auth.
      if (path === '/retrieve' && req.method === 'POST') return await handleRetrieve(req);
      if (path === '/save' && req.method === 'POST') return await handleSave(req);

      // Everything else (UI + admin API) requires basic auth.
      if (!checkAuth(req)) return unauthorized();
      if (path === '/' || path === '/ui' || path === '/ui/') {
        return new Response(readFileSync(UI_HTML_PATH), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (path.startsWith('/api/')) return await handleApi(req, url);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
});

console.log(`[memory-pool] listening on http://${BIND}:${PORT} (qdrant: ${qdrantUrl()}, embeddings: ${embeddingsProvider()})`);
logActivity({ kind: 'admin', detail: `service started on ${BIND}:${PORT}` });

async function shutdown(): Promise<void> {
  console.log('[memory-pool] shutting down — flushing buffers');
  await Promise.all([...chunkers.values()].map(c => c.flushAll()));
  server.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
