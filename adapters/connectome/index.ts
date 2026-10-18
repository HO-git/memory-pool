/**
 * memory-pool for Connectome: archive the agent's conversations with the
 * users you list into a shared memory pool, and optionally give the agent an
 * `archive--recall` tool to search it.
 *
 * A thin, fail-open client of the memory-pool service (see ../../service),
 * which owns embeddings and the Qdrant collection. The same collection can be
 * shared with SillyTavern's st-qdrant-memory and with ChapterX bots.
 *
 *   SAVE (always): only conversations between a listed user and the agent.
 *   When the agent replies on a turn a listed user started, the user's
 *   messages in that channel that woke the agent are saved together with the
 *   reply. A listed user talking to other people or other bots, or the
 *   agent's own autonomous turns (heartbeats, other people's turns), never
 *   reach the archive. The service chunks and embeds, and dedups by message id.
 *
 *   RECALL (opt-in, `recall: true`): an `archive--recall` tool. The agent
 *   searches with its own query when it wants to. Nothing is added to the
 *   prompt automatically, so prompt caching is unaffected. Messages still in
 *   the agent's verbatim context are left out of the results: the module
 *   reads how many messages the last compile kept raw, so the cut follows the
 *   active tail (runtime overrides included) rather than a fixed count.
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
 * file has no runtime dependency on any framework version. What it reads from
 * the framework (the turn's trigger, the context manager's render stats) is
 * duck-typed and optional: on a host that lacks it, the module falls back.
 */

import type {
  ContentBlock,
  EventResponse,
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

/** The parts of AgentFramework this module reads. The host hands the framework
 *  to extension modules through `setFramework`; every member is optional so a
 *  host or framework version without one degrades instead of failing. */
interface FrameworkLike {
  getAgent?(name: string): AgentLike | null;
  getAllAgents?(): AgentLike[];
  getActiveTurnTrigger?(agentName: string): { reason?: string; channelId?: string } | undefined;
  /** The MCPL channel registry, for channel names. */
  readonly channels?: { getDescriptor?(channelId: string): { label?: string } | undefined } | null;
}

interface AgentLike {
  name: string;
  getContextManager?(): ContextManagerLike;
}

interface ContextManagerLike {
  getMessageCount?(): number;
  getMessageWindow?(offset: number, limit: number): { messages: StoredMessage[] };
  getRenderStats?(): { tail?: { messages?: number } } | null;
}

/** One hit from the service's POST /retrieve. */
interface Hit {
  score: number;
  text: string;
  speakers: string;
  timestamp: number;
  source?: string;
  channelId?: string;
  channelName?: string;
}

/** The module name: the agent sees its tool as `archive--recall`. */
const MODULE_NAME = 'archive';

export interface MemoryPoolConfig {
  /** memory-pool service URL. */
  serviceUrl: string;
  /** Bot key in the service's config.json (selects collection and speaker names). */
  bot: string;
  /** User ids whose conversations with the agent are saved. */
  userIds: string[];
  /** Only save in these channels (MCPL ids, e.g. `discord:{guildId}:{channelId}`). Empty = all. */
  channels: string[];
  /** Give the agent an `archive--recall` tool. */
  recall: boolean;
  /** Excerpts recall returns when the agent doesn't ask for a number. */
  recallLimit: number;
  /** Replaces the recall tool's description, e.g. to say how it relates to the agent's other memory tools. */
  recallDescription?: string;
  /** Fallback when the host can't report the active tail: leave out the newest
   *  messages up to about this many tokens. */
  excludeRecentTokens: number;
  /** How many of the newest stored messages are searched for the turn's user messages at reply time. */
  saveLookback: number;
  /** Timeout for save calls, in ms. */
  requestTimeoutMs: number;
  /** Timeout for recall (one embeddings call plus a search), in ms. */
  recallTimeoutMs: number;
}

const DEFAULTS = {
  serviceUrl: 'http://127.0.0.1:3102',
  recallLimit: 6,
  excludeRecentTokens: 50_000,
  saveLookback: 200,
  requestTimeoutMs: 3500,
  recallTimeoutMs: 15_000,
};

const RECALL_MAX_LIMIT = 20;

const DEFAULT_RECALL_DESCRIPTION =
  'Search the archive: your long-term memory of past conversations, including ones from ' +
  'before you came here and from other places you talk that share it. What is still in ' +
  'your context is left out. Use your own words for what you want to remember: a topic, ' +
  'an event, a detail. Returns the closest excerpts, each with its date and where it ' +
  'happened. If you also have history tools, those search your own record here; this ' +
  'archive is the shared, longer-term one.';

export class MemoryPoolModule implements Module {
  readonly name = MODULE_NAME;

  private ctx: ModuleContext | null = null;
  private framework: FrameworkLike | null = null;
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

  /** Called by connectome-host after the framework is created. */
  setFramework(framework: unknown): void {
    this.framework = framework as FrameworkLike;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // =========================================================================
  // Save
  // =========================================================================

  async onAgentSpeech(agentName: string, content: ContentBlock[], context: SpeechContext): Promise<void> {
    // Only replies on turns started by a channel message can be conversations.
    if (context.trigger.reason !== 'mcpl:channel-incoming') return;

    // On a turn that used any tool (a `think` round, a forced first think),
    // the framework hands modules the reply as `thoughts`, not speech, though
    // it still delivers it to the channel. Use it when the turn is complete.
    // (Prose the agent wrote after an explicit send tool is not delivered but
    // would still appear here; that case is rare and accepted.)
    const text = textOf(content) || (context.turnComplete ? textOf(context.thoughts ?? []) : '');
    if (!text) return;

    const recent = this.newestMessages(agentName, this.config.saveLookback)
      .filter((m) => !!m.metadata?.author && !!m.metadata?.messageId);
    const place = this.turnPlace(agentName, recent);
    if (!place || !this.inSavedChannel(place)) return;

    // The turn is the user's only if the newest message that woke the agent
    // in this channel is theirs: a stranger's mention in a shared channel, or
    // another bot, doesn't make a conversation with the user.
    const inPlace = recent.filter((m) => m.metadata?.channelId === place);
    const woke = inPlace.filter((m) => m.metadata?.triggered === true);
    const trigger = woke[woke.length - 1];
    if (!trigger || !this.isSavedUser(trigger)) return;

    // The user's messages here that woke the agent. Earlier ones are already
    // saved (the service dedups by id); a message the agent didn't answer is
    // picked up with the next reply in this channel.
    const userMessages = woke.filter((m) => this.isSavedUser(m)).map((m) => {
      const author = m.metadata?.author as { id?: unknown; name?: string };
      const ts = m.timestamp instanceof Date ? m.timestamp.getTime() : Date.parse(String(m.timestamp));
      return this.withChannel({
        speaker_kind: 'user',
        user_id: String(author.id),
        speaker_name: author.name,
        text: rawText(m.metadata, m.content),
        message_id: String(m.metadata?.messageId),
        ts: Number.isFinite(ts) ? ts : Date.now(),
      }, place);
    }).filter((m) => m.text);

    const triggerId = String(trigger.metadata?.messageId);
    if (this.speechTurn?.triggerId !== triggerId) this.speechTurn = { triggerId, n: 0 };
    this.speechTurn.n += 1;
    const reply = this.withChannel({
      speaker_kind: 'self',
      text,
      message_id: `self-${triggerId}-${this.speechTurn.n}`,
      ts: Date.now(),
    }, place);

    // One request, user messages first, so the chunk reads in order.
    await this.service('/save', {
      bot: this.config.bot,
      source: sourceOf(place),
      messages: [...userMessages, reply],
    }, this.config.requestTimeoutMs).catch((err) => console.error('[memory-pool] save failed:', err));
  }

  // =========================================================================
  // Recall
  // =========================================================================

  getTools(): ToolDefinition[] {
    if (!this.config.recall) return [];
    return [{
      name: 'recall',
      description: this.config.recallDescription ?? DEFAULT_RECALL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to remember, in a few words or a sentence.' },
          limit: {
            type: 'integer',
            description: `How many excerpts at most (1-${RECALL_MAX_LIMIT}, default ${this.config.recallLimit}).`,
          },
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
        : this.config.recallLimit;

    try {
      const res = await this.service('/retrieve', {
        bot: this.config.bot,
        query_text: query,
        exclude_message_ids: this.inContextMessageIds(call.callerAgentName),
        limit,
      }, this.config.recallTimeoutMs);
      if (res.skipped === true) {
        return { success: true, data: 'Recall is turned off in the memory service right now.' };
      }
      const hits = Array.isArray(res.hits) ? (res.hits as Hit[]) : [];
      return { success: true, data: hits.length > 0 ? formatHits(hits, (id) => this.channelName(id)) : 'No matching memories.' };
    } catch (err) {
      return {
        success: false,
        isError: true,
        error: `The archive is unavailable right now (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** The channel's display name from the host's channel registry, if known. */
  private channelName(channelId: string | undefined): string | undefined {
    if (!channelId) return undefined;
    try {
      const label = this.framework?.channels?.getDescriptor?.(channelId)?.label;
      return typeof label === 'string' && label.trim() ? label.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private withChannel(message: Record<string, unknown>, channelId: string): Record<string, unknown> {
    message.channel_id = channelId;
    const name = this.channelName(channelId);
    if (name) message.channel_name = name;
    const guildId = guildOf(channelId);
    if (guildId) message.guild_id = guildId;
    return message;
  }

  private isSavedUser(m: StoredMessage): boolean {
    const author = m.metadata?.author as { id?: unknown } | undefined;
    return author?.id != null && this.config.userIds.includes(String(author.id)) && m.metadata?.isBot !== true;
  }

  private inSavedChannel(channelId: string): boolean {
    return this.config.channels.length === 0 || this.config.channels.includes(channelId);
  }

  /** The channel the current turn belongs to: the framework's record of the
   *  turn's trigger, else the newest message that woke the agent. */
  private turnPlace(agentName: string, recent: StoredMessage[]): string | undefined {
    try {
      const channelId = this.framework?.getActiveTurnTrigger?.(agentName)?.channelId;
      if (channelId) return channelId;
    } catch {
      // fall through to the stored messages
    }
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i]!.metadata?.triggered === true) return recent[i]!.metadata?.channelId as string | undefined;
    }
    return undefined;
  }

  private contextManager(agentName?: string): ContextManagerLike | undefined {
    try {
      const fw = this.framework;
      const agent = (agentName ? fw?.getAgent?.(agentName) : null) ?? fw?.getAllAgents?.()[0];
      return agent?.getContextManager?.();
    } catch {
      return undefined;
    }
  }

  /** The newest `n` stored messages, oldest first. Reads only that window when
   *  the host exposes the context manager, instead of scanning the store. */
  private newestMessages(agentName: string | undefined, n: number): StoredMessage[] {
    const cm = this.contextManager(agentName);
    try {
      const total = cm?.getMessageCount?.();
      if (typeof total === 'number' && cm?.getMessageWindow) {
        return cm.getMessageWindow(Math.max(0, total - n), n).messages;
      }
    } catch {
      // fall back to the module query
    }
    return this.ctx ? this.ctx.queryMessages({}).messages.slice(-n) : [];
  }

  /** Platform ids of the messages still verbatim in the agent's context, so
   *  recall doesn't return what the agent can already see. Uses the last
   *  compile's tail size; without it, the newest ~excludeRecentTokens. */
  private inContextMessageIds(agentName?: string): string[] {
    let tailCount: number | undefined;
    try {
      const n = this.contextManager(agentName)?.getRenderStats?.()?.tail?.messages;
      if (typeof n === 'number' && n > 0) tailCount = n;
    } catch {
      // no render stats yet (before the first compile) or not supported
    }

    let recent: StoredMessage[];
    if (tailCount !== undefined) {
      recent = this.newestMessages(agentName, tailCount);
    } else {
      const window = this.newestMessages(agentName, 2000);
      let tokens = 0;
      let start = window.length;
      while (start > 0 && tokens < this.config.excludeRecentTokens) {
        start -= 1;
        tokens += Math.ceil(JSON.stringify(window[start]!.content ?? '').length / 4);
      }
      recent = window.slice(start);
    }

    const ids: string[] = [];
    for (const m of recent) {
      const id = m.metadata?.messageId;
      if (typeof id !== 'string' || !id) continue;
      ids.push(id);
      // The agent's replies are saved as self-<trigger id>-<n>.
      if (m.metadata?.triggered === true) ids.push(`self-${id}-1`, `self-${id}-2`, `self-${id}-3`);
    }
    return ids;
  }

  private async service(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.config.serviceUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`memory-pool ${path} ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Platform text as the user typed it (discord-mcpl's rawContent), else text blocks. */
function rawText(metadata: Record<string, unknown> | undefined, content: ContentBlock[] | undefined): string {
  const raw = metadata?.rawContent;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return textOf(content ?? []);
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

/** Recall results with each excerpt's date and where it happened. Points
 *  SillyTavern wrote carry no `source`; older pool points carry no channel
 *  name, so it is looked up from their channel id when the host knows it. */
function formatHits(hits: Hit[], nameOf: (channelId: string | undefined) => string | undefined): string {
  const blocks = hits.map((hit, i) => {
    const date = hit.timestamp ? new Date(hit.timestamp).toISOString().slice(0, 10) : 'undated';
    const channel = hit.channelName ?? nameOf(hit.channelId);
    const source = [hit.source ?? 'sillytavern', channel].filter(Boolean).join(' ');
    // Chunk text starts with its own "[YYYY-MM-DD]" line; the header has the date.
    const body = hit.text.replace(/^\[\d{4}-\d{2}-\d{2}\]\n/, '').trim();
    const score = Math.round(hit.score * 100);
    return `[${i + 1}] ${date} · ${source} · ${hit.speakers} · ${score}% match\n${body}`;
  });
  return `${hits.length} excerpt(s) from the archive, closest first:\n\n${blocks.join('\n\n')}`;
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
    recallLimit: Math.min(positive(config.recallLimit, DEFAULTS.recallLimit), RECALL_MAX_LIMIT),
    ...(typeof config.recallDescription === 'string' && config.recallDescription.trim()
      ? { recallDescription: config.recallDescription.trim() }
      : {}),
    excludeRecentTokens: positive(config.excludeRecentTokens, DEFAULTS.excludeRecentTokens),
    saveLookback: positive(config.saveLookback, DEFAULTS.saveLookback),
    requestTimeoutMs: positive(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    recallTimeoutMs: positive(config.recallTimeoutMs, DEFAULTS.recallTimeoutMs),
  };
}

export function register(api: ExtensionApi, config: Record<string, unknown>): void {
  const parsed = parseConfig(config ?? {});
  api.registerModule(() => new MemoryPoolModule(parsed));
}
