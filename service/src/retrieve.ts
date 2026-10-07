import type { BotConfig, MemoryHit, RetrieveResponse } from './types.ts';
import { generateEmbedding } from './embeddings.ts';
import { search } from './qdrant.ts';

/** st-qdrant-memory dedup normalization: strip [dates], collapse whitespace, first 200 chars. */
function normalizeForDedup(text: string): string {
  return text
    .replace(/\[[\d-]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

export async function retrieve(
  cfg: BotConfig,
  queryText: string,
  excludeMessageIds: string[],
  limitOverride?: number,
): Promise<RetrieveResponse> {
  const memoryLimit = limitOverride ?? cfg.memoryLimit;
  const vector = await generateEmbedding(queryText, cfg.embeddingModel, cfg.embeddingDimensions);
  // Same shape as the ST extension: fetch double, then post-filter.
  let results = await search(cfg.collection, vector, memoryLimit * 2, cfg.scoreThreshold);

  // Exclude chunks containing messages that are already in the caller's context.
  if (excludeMessageIds.length > 0) {
    const excluded = new Set(excludeMessageIds);
    results = results.filter(hit => {
      const messageIds = String(hit.payload.messageIds ?? '');
      return !messageIds.split(',').some(id => excluded.has(id.trim()));
    });
  }

  // Dedup near-identical chunks by normalized text.
  const seenTexts = new Set<string>();
  results = results.filter(hit => {
    const norm = normalizeForDedup(String(hit.payload.text ?? ''));
    if (seenTexts.has(norm)) return false;
    seenTexts.add(norm);
    return true;
  });

  results = results.slice(0, memoryLimit);

  const hits: MemoryHit[] = results.map(hit => ({
    id: hit.id,
    score: hit.score,
    text: String(hit.payload.text ?? ''),
    speakers: String(hit.payload.speakers ?? ''),
    timestamp: Number(hit.payload.timestamp ?? 0),
    messageIds: String(hit.payload.messageIds ?? ''),
    source: hit.payload.source ? String(hit.payload.source) : undefined,
    channelId: hit.payload.channelId ? String(hit.payload.channelId) : undefined,
  }));

  // Formatted block — byte-compatible with st-qdrant-memory's formatMemories.
  let formatted = '';
  if (hits.length > 0) {
    formatted = '\n[Past chat memories]\n\n';
    for (const hit of hits) {
      const speakerLabel = `Conversation (${hit.speakers})`;
      const text = hit.text.replace(/\n/g, ' ');
      const score = (hit.score * 100).toFixed(0);
      formatted += `• ${speakerLabel}: "${text}" (score: ${score}%)\n\n`;
    }
  }

  return { formatted, hits, count: hits.length };
}
