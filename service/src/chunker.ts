import { randomUUID } from 'node:crypto';
import type { BotConfig, ChunkPayload, SaveMessage } from './types.ts';
import { generateEmbedding } from './embeddings.ts';
import { ensureCollection, upsertPoint } from './qdrant.ts';
import { logActivity } from './activity.ts';
import { SeenIds } from './seen.ts';

/** Mirrors st-qdrant-memory's formatDateForChunk: YYYY-MM-DD from the oldest message. */
function formatDateForChunk(timestamp: number): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0]!;
  return d.toISOString().split('T')[0]!;
}

interface BufferedMessage {
  speaker: string;
  text: string;
  messageId: string;
  ts: number;
}

interface Buffer {
  messages: BufferedMessage[];
  source: string;
  chars: number;
  channelId?: string;
  guildId?: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Delay before flushing once the buffer passes chunkMinSize (same as the ST extension). */
const MIN_SIZE_FLUSH_MS = 5_000;

/**
 * Per-bot save pipeline with st-qdrant-memory chunking semantics:
 * buffer messages; flush immediately at >= chunkMaxSize chars, after 5s
 * at >= chunkMinSize, else after chunkTimeoutMs. One buffer per
 * (bot, source, channel) so chunks never interleave conversations.
 */
export class BotChunker {
  private buffers = new Map<string, Buffer>();
  readonly seen: SeenIds;
  private ensuredCollections = new Set<string>();

  constructor(
    private botName: string,
    private getCfg: () => BotConfig,
  ) {
    this.seen = new SeenIds(botName);
  }

  resolveSpeaker(msg: SaveMessage, cfg: BotConfig): string {
    if (msg.speaker_kind === 'self') return cfg.selfSpeaker;
    const userId = msg.user_id ?? msg.discord_user_id;
    if (userId && cfg.speakerAliases[userId]) {
      return cfg.speakerAliases[userId]!;
    }
    return msg.speaker_name || 'Unknown';
  }

  /** Accept messages; returns how many were newly buffered (vs filtered/duplicate). */
  accept(messages: SaveMessage[], source = 'discord'): number {
    const cfg = this.getCfg();
    let buffered = 0;
    for (const msg of messages) {
      const text = (msg.text ?? '').trim();
      if (text.length < cfg.minMessageLength) continue;
      if (this.seen.has(msg.message_id)) continue;

      const key = `${source}:${msg.channel_id ?? 'unknown'}`;
      let buf = this.buffers.get(key);
      if (!buf) {
        buf = { messages: [], source, chars: 0, channelId: msg.channel_id, guildId: msg.guild_id, timer: null };
        this.buffers.set(key, buf);
      }
      buf.messages.push({
        speaker: this.resolveSpeaker(msg, cfg),
        text,
        messageId: msg.message_id,
        ts: msg.ts || Date.now(),
      });
      buf.chars += text.length;
      this.seen.addAll([msg.message_id]);
      buffered++;
      this.schedule(key, buf, cfg);
    }
    return buffered;
  }

  private schedule(key: string, buf: Buffer, cfg: BotConfig): void {
    if (buf.timer) clearTimeout(buf.timer);
    if (buf.chars >= cfg.chunkMaxSize) {
      buf.timer = null;
      void this.flush(key);
      return;
    }
    const delay = buf.chars >= cfg.chunkMinSize ? MIN_SIZE_FLUSH_MS : cfg.chunkTimeoutMs;
    buf.timer = setTimeout(() => void this.flush(key), delay);
  }

  async flush(key: string): Promise<void> {
    const buf = this.buffers.get(key);
    if (!buf || buf.messages.length === 0) return;
    this.buffers.delete(key);
    if (buf.timer) clearTimeout(buf.timer);

    const cfg = this.getCfg();
    const msgs = buf.messages;

    // Chunk text — byte-compatible with st-qdrant-memory:
    // "[YYYY-MM-DD]\nSpeaker: text\nSpeaker: text\n" (date = oldest message)
    let chunkText = '';
    for (const m of msgs) chunkText += `${m.speaker}: ${m.text}\n`;
    const oldestTs = Math.min(...msgs.map(m => m.ts));
    const finalText = `[${formatDateForChunk(oldestTs)}]\n${chunkText}`;

    const payload: ChunkPayload = {
      text: finalText,
      speakers: [...new Set(msgs.map(m => m.speaker))].join(', '),
      messageCount: msgs.length,
      timestamp: oldestTs,
      messageIds: msgs.map(m => m.messageId).join(','),
      isChunk: true,
      source: buf.source,
      ...(buf.channelId ? { channelId: buf.channelId } : {}),
      ...(buf.guildId ? { guildId: buf.guildId } : {}),
    };

    try {
      if (!this.ensuredCollections.has(cfg.collection)) {
        await ensureCollection(cfg.collection, cfg.embeddingDimensions);
        this.ensuredCollections.add(cfg.collection);
      }
      const vector = await generateEmbedding(finalText, cfg.embeddingModel, cfg.embeddingDimensions);
      await upsertPoint(cfg.collection, randomUUID(), vector, payload as unknown as Record<string, unknown>);
      logActivity({
        kind: 'save',
        bot: this.botName,
        detail: `saved chunk: ${msgs.length} msg(s), ${finalText.length} chars → ${cfg.collection}`,
        data: { speakers: payload.speakers, chars: finalText.length, channelId: buf.channelId },
      });
    } catch (err) {
      logActivity({
        kind: 'error',
        bot: this.botName,
        detail: `save flush failed (chunk dropped): ${(err as Error).message}`,
        data: { messageCount: msgs.length, chars: finalText.length },
      });
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.buffers.keys()].map(key => this.flush(key)));
  }

  bufferedCount(): number {
    let n = 0;
    for (const buf of this.buffers.values()) n += buf.messages.length;
    return n;
  }
}
