/**
 * memory-pool for Connectome: save conversations into a shared memory pool,
 * and optionally give the agent a `recall` tool to search it.
 *
 * A thin, fail-open client of the memory-pool service (see ../../service),
 * which owns embeddings and the Qdrant collection. The same collection can be
 * shared with SillyTavern's st-qdrant-memory and with ChapterX bots.
 *
 *   SAVE (always): messages from the configured users are sent to the
 *   service as they arrive. The agent's replies are sent too, but only on
 *   turns one of those users triggered, so autonomous output (heartbeats,
 *   other people's turns) stays out of the pool. The service chunks and
 *   embeds them, and dedups by message id.
 *
 *   RECALL (opt-in, `recall: true`): a `memory--recall` tool. The agent
 *   searches with its own query when it wants to. Nothing is added to the
 *   prompt automatically, so prompt caching is unaffected.
 *
 * Load it from a connectome-host recipe:
 *
 *   "extensions": {
 *     "memory-pool": {
 *       "kind": "module",
 *       "path": "./path/to/memory-pool/adapters/connectome/index.ts",
 *       "config": { "bot": "my-agent", "userIds": ["${MY_DISCORD_USER_ID}"], "recall": false }
 *     }
 *   }
 *
 * Only type imports from @animalabs/*: they are erased at runtime, so this
 * file has no runtime dependency on any framework version.
 */

import type {
  ContentBlock,
  EventResponse,
  McplChannelIncomingEvent,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  SpeechContext,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@animalabs/agent-framework';

// The host's side of the contract (connectome-host src/extensions.ts),
// declared here so this file needs nothing from the host package.
interface ModuleFactoryContext {
  timeZone: string;
  storePath: string;
  model: string;
  config: Record<string, unknown>;
}

interface ExtensionApi {
  registerModule(factory: (ctx: ModuleFactoryContext) => Module): void;
}

/** A stored message, as ModuleContext.queryMessages returns it. */
type StoredMessage = ReturnType<ModuleContext['queryMessages']>['messages'][number];

export interface MemoryPoolConfig {
  /** memory-pool service URL. */
  serviceUrl: string;
  /** Bot key in the service's config.json (selects collection and speaker names). */
  bot: string;
  /** User ids whose conversations with the agent are saved. */
  userIds: string[];
  /** Only save in these channels (MCPL ids, e.g. `discord:{guildId}:{channelId}`). Empty = all. */
  channels: string[];
  /** Give the agent a `memory--recall` tool. */
  recall: boolean;
  /** Recent message ids excluded from recall results (they are already in context). */
  excludeRecentCount: number;
  /** Per-request timeout for service calls, in ms. */
  requestTimeoutMs: number;
}

const DEFAULTS = {
  serviceUrl: 'http://127.0.0.1:3102',
  excludeRecentCount: 25,
  requestTimeoutMs: 3500,
};

const RECALL_MAX_LIMIT = 20;

export class MemoryPoolModule implements Module {
  readonly name = 'memory';

  private ctx: ModuleContext | null = null;
  /** Message id of the triggering message whose reply we're attributing, and a counter. */
  private speechTurn: { triggerId: string; n: number } | null = null;

  constructor(private readonly config: MemoryPoolConfig) {}

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    // Additive: observe the agent's speech without displacing the handler
    // that delivers it.
    ctx.registerSpeechHandler('*', { additive: true });
  }

  async stop(): Promise<void> {
    this.ctx?.unregisterSpeechHandler();
    this.ctx = null;
  }

  // =========================================================================
  // Save
  // =========================================================================

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'mcpl:channel-incoming') return {};
    const e = event as McplChannelIncomingEvent;
    if (!this.isSavedUser(e.author?.id, e.metadata) || !this.inSavedChannel(e.channelId)) return {};

    const text = rawText(e.metadata, e.content);
    if (!text) return {};
    const ts = Date.parse(e.timestamp);
    const message: Record<string, unknown> = {
      speaker_kind: 'user',
      user_id: String(e.author.id),
      speaker_name: e.author.name,
      text,
      message_id: e.messageId,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      channel_id: e.channelId,
    };
    const guildId = guildOf(e.channelId);
    if (guildId) message.guild_id = guildId;

    // Fire and forget: saving must never hold up the agent.
    this.service('/save', { bot: this.config.bot, source: sourceOf(e.channelId), messages: [message] })
      .catch((err) => console.error('[memory-pool] save failed:', err));
    return {};
  }

  async onAgentSpeech(_agentName: string, content: ContentBlock[], context: SpeechContext): Promise<void> {
    // Only replies on turns a saved user triggered become memories.
    if (context.trigger.reason !== 'mcpl:channel-incoming') return;
    const trigger = this.newestTrigger();
    if (!trigger) return;
    const author = trigger.metadata?.author as { id?: string } | undefined;
    const channelId = trigger.metadata?.channelId as string | undefined;
    if (!this.isSavedUser(author?.id, trigger.metadata) || !this.inSavedChannel(channelId)) return;

    const text = content
      .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!text) return;

    const triggerId = String(trigger.metadata?.messageId ?? trigger.id);
    if (this.speechTurn?.triggerId !== triggerId) this.speechTurn = { triggerId, n: 0 };
    this.speechTurn.n += 1;

    const message: Record<string, unknown> = {
      speaker_kind: 'self',
      text,
      message_id: `self-${triggerId}-${this.speechTurn.n}`,
      ts: Date.now(),
    };
    if (channelId) {
      message.channel_id = channelId;
      const guildId = guildOf(channelId);
      if (guildId) message.guild_id = guildId;
    }
    await this.service('/save', { bot: this.config.bot, source: sourceOf(channelId), messages: [message] })
      .catch((err) => console.error('[memory-pool] speech save failed:', err));
  }

  // =========================================================================
  // Recall
  // =========================================================================

  getTools(): ToolDefinition[] {
    if (!this.config.recall) return [];
    return [{
      name: 'recall',
      description:
        'Search your long-term memory of past conversations (including ones from other ' +
        'places you talk, if they share this memory). Use your own words for what you want to ' +
        'remember: a topic, an event, a detail. Returns the closest past excerpts, with dates.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to remember, in a few words or a sentence.' },
          limit: { type: 'integer', description: `How many excerpts at most (1-${RECALL_MAX_LIMIT}).` },
        },
        required: ['query'],
      },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== 'recall' || !this.config.recall) {
      return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
    }
    const input = (call.input ?? {}) as { query?: unknown; limit?: unknown };
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return { success: false, isError: true, error: 'recall needs a non-empty query.' };
    const limit =
      typeof input.limit === 'number' && Number.isInteger(input.limit)
        ? Math.min(Math.max(input.limit, 1), RECALL_MAX_LIMIT)
        : undefined;

    try {
      const res = await this.service('/retrieve', {
        bot: this.config.bot,
        query_text: query,
        exclude_message_ids: this.recentMessageIds(),
        ...(limit ? { limit } : {}),
      });
      if (res.skipped === true) {
        return { success: true, data: 'Recall is turned off in the memory service right now.' };
      }
      const formatted = typeof res.formatted === 'string' ? res.formatted.trim() : '';
      return { success: true, data: formatted || 'No matching memories.' };
    } catch (err) {
      return {
        success: false,
        isError: true,
        error: `Memory is unavailable right now (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private isSavedUser(authorId: unknown, metadata?: Record<string, unknown>): boolean {
    return authorId != null && this.config.userIds.includes(String(authorId)) && metadata?.isBot !== true;
  }

  private inSavedChannel(channelId: string | undefined): boolean {
    return this.config.channels.length === 0 || (!!channelId && this.config.channels.includes(channelId));
  }

  /** Stored channel messages (they carry author and platform message id), in order. */
  private channelMessages(): StoredMessage[] {
    if (!this.ctx) return [];
    const { messages } = this.ctx.queryMessages({});
    return messages.filter((m) => !!m.metadata?.author && !!m.metadata?.messageId);
  }

  /** Newest message whose arrival triggered a turn: the current turn's cause. */
  private newestTrigger(): StoredMessage | null {
    const messages = this.channelMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.metadata?.triggered === true) return messages[i]!;
    }
    return null;
  }

  private recentMessageIds(): string[] {
    return this.channelMessages()
      .slice(-this.config.excludeRecentCount)
      .map((m) => m.metadata?.messageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  private async service(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.config.serviceUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`memory-pool ${path} ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** Platform text as the user typed it (discord-mcpl's rawContent), else text blocks. */
function rawText(metadata: Record<string, unknown> | undefined, content: ContentBlock[] | undefined): string {
  const raw = metadata?.rawContent;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return (content ?? [])
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** The platform a channel belongs to (`discord:…` → `discord`), recorded as the chunk's source. */
function sourceOf(channelId: string | undefined): string {
  const platform = (channelId ?? '').split(':')[0] ?? '';
  return /^[A-Za-z0-9_.-]{1,40}$/.test(platform) ? platform : 'connectome';
}

/** `discord:{guildId}:{channelId}` → guildId. */
function guildOf(channelId: string | undefined): string | undefined {
  const parts = (channelId ?? '').split(':');
  return parts.length === 3 && parts[1] && parts[1] !== 'dm' ? parts[1] : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((s) => s.trim() !== '') : [];
}

export function parseConfig(config: Record<string, unknown>): MemoryPoolConfig {
  const bot = typeof config.bot === 'string' ? config.bot.trim() : '';
  const userIds = stringList(config.userIds);
  if (!bot) throw new Error('memory-pool needs "bot" (the bot key in the service config)');
  if (userIds.length === 0) throw new Error('memory-pool needs "userIds" (whose conversations to save)');
  const positive = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d);
  return {
    serviceUrl: typeof config.serviceUrl === 'string' && config.serviceUrl ? config.serviceUrl.replace(/\/$/, '') : DEFAULTS.serviceUrl,
    bot,
    userIds,
    channels: stringList(config.channels),
    recall: config.recall === true,
    excludeRecentCount: positive(config.excludeRecentCount, DEFAULTS.excludeRecentCount),
    requestTimeoutMs: positive(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
  };
}

export function register(api: ExtensionApi, config: Record<string, unknown>): void {
  const parsed = parseConfig(config ?? {});
  api.registerModule(() => new MemoryPoolModule(parsed));
}
