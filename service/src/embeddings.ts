const PROVIDER = (process.env.EMBEDDINGS_PROVIDER || 'openai').toLowerCase();
const API_KEY = process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY || '';

const PROVIDER_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/embeddings',
  openrouter: 'https://openrouter.ai/api/v1/embeddings',
};
// custom provider: set EMBEDDINGS_URL to any OpenAI-compatible /embeddings endpoint
const ENDPOINT = process.env.EMBEDDINGS_URL || PROVIDER_URLS[PROVIDER] || '';

export function embeddingsProvider(): string {
  return PROVIDER;
}

export async function generateEmbedding(text: string, model: string, dimensions: number): Promise<number[]> {
  if (PROVIDER === 'stub') return stubEmbedding(text, dimensions);
  if (!ENDPOINT) throw new Error(`no embeddings endpoint for provider "${PROVIDER}" (set EMBEDDINGS_URL?)`);
  if (!API_KEY) throw new Error('EMBEDDINGS_API_KEY not set (and EMBEDDINGS_PROVIDER is not "stub")');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${PROVIDER} embeddings ${res.status}: ${body.slice(0, 300)}`);
  }
  // Same tolerant response parsing as st-qdrant-memory.
  const data = (await res.json()) as Record<string, any>;
  const vec: unknown =
    data.data?.[0]?.embedding ?? data.data?.[0]?.vector ?? data.embedding ?? data.embeddings?.[0];
  if (!Array.isArray(vec)) throw new Error(`${PROVIDER} embeddings: unexpected response shape`);
  if (vec.length !== dimensions) {
    throw new Error(`Embedding dimension mismatch: got ${vec.length}, collection expects ${dimensions} — wrong model?`);
  }
  return vec as number[];
}

/**
 * Deterministic bag-of-words embedding for pipeline testing only.
 * Token-overlap correlates with cosine similarity, so save→retrieve
 * round-trips rank sensibly without any API key. NOT compatible with
 * real collections.
 */
function stubEmbedding(text: string, dimensions: number): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dimensions;
    vec[idx] += (h & 1) === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}
