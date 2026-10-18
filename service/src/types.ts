export interface GlobalConfig {
  paused: boolean;
  debug: boolean;
}

export interface BotConfig {
  /** Allow searching this bot's collection (POST /retrieve, e.g. a recall tool).
   *  Independent of `autoSave`: recall off + autoSave on is a pure archive.
   *  (Older configs called this `enabled`; it is still read.) */
  recall: boolean;
  /** Write incoming conversation into the collection (POST /save). */
  autoSave: boolean;
  collection: string;
  embeddingModel: string;
  embeddingDimensions: number;
  memoryLimit: number;
  scoreThreshold: number;
  minMessageLength: number;
  chunkMinSize: number;
  chunkMaxSize: number;
  chunkTimeoutMs: number;
  /** Speaker label for the agent's own messages (to share a pool with SillyTavern, its character name there) */
  selfSpeaker: string;
  /** platform user id -> speaker label (must match the user's ST persona name to share a pool with SillyTavern) */
  speakerAliases: Record<string, string>;
}

export interface ServiceConfig {
  global: GlobalConfig;
  bots: Record<string, BotConfig>;
}

/** One message reported to POST /save */
export interface SaveMessage {
  /** "self" = the bot's own speech, "user" = an inbound human message */
  speaker_kind: 'self' | 'user';
  /** Platform user id, matched against speakerAliases. */
  user_id?: string;
  /** @deprecated older name for user_id; still read. */
  discord_user_id?: string;
  /** Fallback label when no alias matches (e.g. other humans) */
  speaker_name?: string;
  text: string;
  /** Platform message id, or a synthetic id for the agent's own speech (unique per agent) */
  message_id: string;
  /** Unix ms */
  ts: number;
  channel_id?: string;
  guild_id?: string;
}

export interface SaveRequest {
  bot: string;
  /** Which interface wrote these messages, stored on each chunk (e.g. "discord", "hermes"). Default "discord". */
  source?: string;
  messages: SaveMessage[];
}

export interface RetrieveRequest {
  bot: string;
  query_text: string;
  /** Message ids currently in the caller's context: chunks containing them are excluded */
  exclude_message_ids?: string[];
  limit?: number;
}

export interface MemoryHit {
  id: string | number;
  score: number;
  text: string;
  speakers: string;
  timestamp: number;
  messageIds: string;
  source?: string;
  channelId?: string;
}

export interface RetrieveResponse {
  formatted: string;
  hits: MemoryHit[];
  count: number;
}

/** st-qdrant-memory compatible point payload (superset: source/channelId/guildId are additive) */
export interface ChunkPayload {
  text: string;
  speakers: string;
  messageCount: number;
  timestamp: number;
  messageIds: string;
  isChunk: true;
  /** Which interface wrote the chunk. Points without it were written by SillyTavern. */
  source: string;
  channelId?: string;
  guildId?: string;
}

export interface ActivityEntry {
  ts: number;
  kind: 'retrieve' | 'save' | 'error' | 'admin';
  bot?: string;
  detail: string;
  data?: Record<string, unknown>;
}
