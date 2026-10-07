const QDRANT_URL = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) h['api-key'] = QDRANT_API_KEY;
  return h;
}

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Qdrant ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export function qdrantUrl(): string {
  return QDRANT_URL;
}

export async function listCollections(): Promise<Array<{ name: string; points: number }>> {
  const data = await request<{ result: { collections: Array<{ name: string }> } }>('GET', '/collections');
  const out: Array<{ name: string; points: number }> = [];
  for (const c of data.result.collections) {
    try {
      const info = await request<{ result: { points_count: number } }>('GET', `/collections/${encodeURIComponent(c.name)}`);
      out.push({ name: c.name, points: info.result.points_count ?? 0 });
    } catch {
      out.push({ name: c.name, points: -1 });
    }
  }
  return out;
}

export async function ensureCollection(name: string, dimensions: number): Promise<void> {
  try {
    await request('GET', `/collections/${encodeURIComponent(name)}`);
    return;
  } catch {
    // fall through to create — same body as st-qdrant-memory
  }
  await request('PUT', `/collections/${encodeURIComponent(name)}`, {
    vectors: { size: dimensions, distance: 'Cosine' },
  });
}

export interface SearchHit {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

export async function search(
  collection: string,
  vector: number[],
  limit: number,
  scoreThreshold: number,
): Promise<SearchHit[]> {
  const data = await request<{ result: SearchHit[] }>(
    'POST',
    `/collections/${encodeURIComponent(collection)}/points/search`,
    { vector, limit, score_threshold: scoreThreshold, with_payload: true },
  );
  return data.result ?? [];
}

export async function upsertPoint(
  collection: string,
  id: string,
  vector: number[],
  payload: Record<string, unknown>,
): Promise<void> {
  await request('PUT', `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
    points: [{ id, vector, payload }],
  });
}

export interface ScrollOptions {
  limit: number;
  offset?: string | number | null;
  /** 'pool' = written by memory-pool (has a source field); 'st' = written by SillyTavern (no source field) */
  source?: PointOrigin | null;
}

export async function scrollPoints(
  collection: string,
  opts: ScrollOptions,
): Promise<{ points: Array<{ id: string | number; payload: Record<string, unknown> }>; nextOffset: string | number | null }> {
  const body: Record<string, unknown> = {
    limit: opts.limit,
    with_payload: true,
    with_vector: false,
  };
  if (opts.offset != null) body.offset = opts.offset;
  if (opts.source) body.filter = originFilter(opts.source);
  const data = await request<{ result: { points: Array<{ id: string | number; payload: Record<string, unknown> }>; next_page_offset: string | number | null } }>(
    'POST',
    `/collections/${encodeURIComponent(collection)}/points/scroll`,
    body,
  );
  return { points: data.result.points ?? [], nextOffset: data.result.next_page_offset ?? null };
}

export async function deletePointsByIds(collection: string, ids: Array<string | number>): Promise<void> {
  await request('POST', `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, { points: ids });
}

/** Where a point came from: written by memory-pool (any interface), or by SillyTavern. */
export type PointOrigin = 'pool' | 'st';

/** memory-pool points carry a `source` field; SillyTavern's never do. */
function originFilter(origin: PointOrigin): Record<string, unknown> {
  const hasNoSource = { is_empty: { key: 'source' } };
  return origin === 'pool' ? { must_not: [hasNoSource] } : { must: [hasNoSource] };
}

/** Delete every point memory-pool wrote (any source); SillyTavern's points are untouched. The rollback safety valve. */
export async function deletePoolPoints(collection: string): Promise<void> {
  await request('POST', `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
    filter: originFilter('pool'),
  });
}

export async function countPoints(collection: string, origin?: PointOrigin): Promise<number> {
  const body: Record<string, unknown> = { exact: true };
  if (origin) body.filter = originFilter(origin);
  const data = await request<{ result: { count: number } }>(
    'POST',
    `/collections/${encodeURIComponent(collection)}/points/count`,
    body,
  );
  return data.result.count ?? 0;
}

export async function ping(): Promise<boolean> {
  try {
    await request('GET', '/collections');
    return true;
  } catch {
    return false;
  }
}

/** Create a server-side snapshot of a collection (backup before write-back goes live). */
export async function snapshotCollection(collection: string): Promise<string> {
  const data = await request<{ result: { name: string } }>(
    'POST',
    `/collections/${encodeURIComponent(collection)}/snapshots?wait=true`,
  );
  return data.result.name;
}
