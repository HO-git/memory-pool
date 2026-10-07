/**
 * memory-pool for ChapterX: save conversations into a shared memory pool,
 * and optionally give the bot a `recall` tool to search it.
 *
 * Two plugins, enabled independently in the bot's YAML:
 *
 *   memory-pool         SAVE. On each activation triggered by one of the
 *                       configured users, reports that user's and the bot's
 *                       recent messages to the memory-pool service, which
 *                       chunks, embeds and dedups them by message id. Adds
 *                       nothing to the context.
 *   memory-pool-recall  RECALL (opt-in). A `recall` tool: the bot searches
 *                       with its own query when it wants to. Reads its
 *                       settings from plugin_config.memory-pool.
 *
 *   tool_plugins: [memory-pool, memory-pool-recall]
 *   plugin_config:
 *     memory-pool:
 *       bot: my-agent                 # bot key in the service's config.json
 *       user_ids: ['<your user id>']  # whose conversations are saved
 *       service_url: http://127.0.0.1:3102
 *       recent_messages: 30           # how far back to report (dedup makes re-sending harmless)
 *       request_timeout_ms: 3500
 *
 * Needs the small agent-loop patch in ./chapterx.patch, which hands this
 * plugin structured recent messages (_recentMessagesRaw) and the bot's own
 * user id (_botUserId).
 */

import type { ToolPlugin, PluginStateContext, PluginContext, ContextInjection } from './types.js'

interface RawRecentMessage {
  id: string
  authorId?: string
  authorName?: string
  isBot: boolean
  content: string
  ts: number
  channelId?: string
  guildId?: string
}

interface MemoryPoolPluginConfig {
  bot?: string
  user_ids?: string[]
  service_url?: string
  request_timeout_ms?: number
  _botUserId?: string
  _recentMessagesRaw?: RawRecentMessage[]
}

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:3102'
const DEFAULT_TIMEOUT_MS = 3500
const RECALL_MAX_LIMIT = 20

// Message ids currently in the bot's context, per `${botId}:${channelId}`,
// remembered from the last activation so recall can leave them out.
const contextIdsByChannel = new Map<string, string[]>()
const CONTEXT_IDS_MAX = 200

async function callService(
  serviceUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, any>> {
  const response = await fetch(`${serviceUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`memory-pool ${path}: ${response.status}`)
  return await response.json() as Record<string, any>
}

export const memoryPoolPlugin: ToolPlugin = {
  name: 'memory-pool',
  description: 'Saves conversations into a shared memory pool (st-qdrant-memory compatible)',
  tools: [],

  // ChapterX's per-activation hook. Used only to save: it always returns no injections.
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const config = (context.pluginConfig ?? {}) as MemoryPoolPluginConfig
    const userIds = config.user_ids ?? []
    const recent = config._recentMessagesRaw
    if (!config.bot || userIds.length === 0 || !recent || recent.length === 0) return []

    remember(`${context.botId}:${context.channelId}`, recent.map(m => m.id))

    // Save only on activations a configured user triggered.
    const trigger = recent.find(m => m.id === context.currentMessageId)
    if (!trigger || trigger.isBot || !trigger.authorId || !userIds.includes(trigger.authorId)) return []

    const botUserId = config._botUserId
    const toSave = recent
      .filter(m => m.content && m.authorId &&
        ((userIds.includes(m.authorId) && !m.isBot) || (botUserId && m.authorId === botUserId)))
      .map(m => ({
        speaker_kind: botUserId && m.authorId === botUserId ? 'self' : 'user',
        user_id: m.authorId,
        speaker_name: m.authorName,
        text: m.content,
        message_id: m.id,
        ts: m.ts,
        channel_id: m.channelId,
        guild_id: m.guildId,
      }))
    if (toSave.length > 0) {
      // Fire and forget: saving must never hold up the bot's turn.
      callService(
        config.service_url || DEFAULT_SERVICE_URL,
        '/save',
        { bot: config.bot, messages: toSave },
        config.request_timeout_ms || DEFAULT_TIMEOUT_MS,
      ).catch(e => console.warn('[memory-pool] save failed:', e?.message || e))
    }
    return []
  },
}

export const memoryPoolRecallPlugin: ToolPlugin = {
  name: 'memory-pool-recall',
  description: 'A recall tool that searches the shared memory pool',
  tools: [
    {
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
      handler: async (input: any, context: PluginContext) => {
        const config = (context.config?.plugin_config?.['memory-pool'] ?? {}) as MemoryPoolPluginConfig
        if (!config.bot) return 'Recall is not set up (plugin_config.memory-pool.bot is missing).'
        const query = typeof input?.query === 'string' ? input.query.trim() : ''
        if (!query) return 'recall needs a non-empty query.'
        const limit = Number.isInteger(input?.limit)
          ? Math.min(Math.max(input.limit, 1), RECALL_MAX_LIMIT)
          : undefined
        try {
          const result = await callService(
            config.service_url || DEFAULT_SERVICE_URL,
            '/retrieve',
            {
              bot: config.bot,
              query_text: query,
              exclude_message_ids: contextIdsByChannel.get(`${context.botId}:${context.channelId}`) ?? [],
              ...(limit ? { limit } : {}),
            },
            config.request_timeout_ms || DEFAULT_TIMEOUT_MS,
          )
          if (result.skipped === true) return 'Recall is turned off in the memory service right now.'
          const formatted = typeof result.formatted === 'string' ? result.formatted.trim() : ''
          return formatted || 'No matching memories.'
        } catch (e) {
          return `Memory is unavailable right now (${(e as Error)?.message || e}).`
        }
      },
    },
  ],
}

function remember(key: string, ids: string[]): void {
  contextIdsByChannel.delete(key)
  contextIdsByChannel.set(key, ids)
  while (contextIdsByChannel.size > CONTEXT_IDS_MAX) {
    const oldest = contextIdsByChannel.keys().next().value
    if (oldest === undefined) break
    contextIdsByChannel.delete(oldest)
  }
}
