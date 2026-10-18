# memory-pool for Connectome

A [connectome-host](https://github.com/anima-research/connectome-host)
extension. It archives the agent's conversations with the users you list into
the memory pool, and can optionally give the agent an `archive--recall` tool.

Your host checkout stays a plain upstream checkout: the recipe loads this file
directly.

## Use it

Run the [service](../../service/) first, then add this to your recipe, with
`path` relative to the recipe file:

```json
"extensions": {
  "memory-pool": {
    "kind": "module",
    "path": "../memory-pool/adapters/connectome/index.ts",
    "config": {
      "bot": "my-agent",
      "userIds": ["${MY_DISCORD_USER_ID}"],
      "recall": false
    }
  }
}
```

The module is named `archive`, so its tool is `archive--recall`. That keeps
it clear of the host's own memory modules (`history--*`, lessons) when you
use those too.

| Config | Default | Meaning |
|---|---|---|
| `bot` | (required) | The agent's key under `bots` in the service's `config.json`. |
| `userIds` | (required) | Platform user ids whose conversations with the agent are saved. |
| `recall` | `false` | Give the agent an `archive--recall` tool. |
| `recallLimit` | `6` | Excerpts recall returns when the agent doesn't ask for a number (max 20). |
| `recallDescription` | built in | Replaces the tool's description, e.g. to say how the archive relates to the agent's other memory tools. |
| `channels` | all | Only save in these channels (e.g. `["discord:{guildId}:{channelId}"]`). |
| `serviceUrl` | `http://127.0.0.1:3102` | Where the service listens. |
| `excludeRecentTokens` | `50000` | Fallback only: when the host can't report the active tail, recall leaves out the newest messages up to about this many tokens. |
| `saveLookback` | `200` | How many of the newest stored messages are searched for the user's messages when the agent replies. |
| `requestTimeoutMs` | `3500` | Timeout for saves. |
| `recallTimeoutMs` | `15000` | Timeout for recall (an embeddings call plus a search). |

Recall also has to be allowed in the service (`"recall": true` for that
agent in `config.json`). If it isn't, the tool says recall is off.

## What it does

- **Saving: only the user's conversations with the agent.** When the agent
  replies on a turn a listed user started, the user's messages in that
  channel that woke the agent are saved together with the reply. What a
  listed user says to other people or other bots, a turn someone else
  started (a stranger's mention in a shared channel), and the agent's
  autonomous turns (heartbeats, timers) are not saved. If the agent doesn't
  answer a message, it's saved with the next reply in that channel. Each save
  is tagged with the channel's platform (`discord`, `zulip`, …) as its
  `source`. Saving never delays a turn; if the service is down, the save is
  skipped with a log line.
- **Replies on tool-using turns.** On a turn that used any tool (including a
  forced first `think`), the framework hands modules the reply as `thoughts`
  rather than speech, though the channel still gets it. The module reads it
  from there, so these replies are saved too.
- **Recall** (when enabled). The agent calls `archive--recall` with a query in
  its own words and gets back the closest excerpts, each with its date, where
  it came from (`discord`, `sillytavern`, …), the speakers and a match
  score.
  Messages still verbatim in the agent's context are left out: the module
  reads how many messages the last compile kept raw (the active tail,
  runtime overrides included), so the cut follows the tail as it changes.
  Nothing is added to the prompt otherwise, so prompt caching is unaffected.

## Limits

- Replies the agent sends through an explicit tool (e.g. a Discord
  `send_message` tool) instead of plain speech are not captured. Prose the
  agent writes after such a tool on the same turn isn't delivered to the
  channel but would be saved.
- Only channel messages are saved, not DMs that arrive as push events.
- Older raw messages that adaptive resolution keeps in the middle of the
  context (outside the tail) are not left out of recall results.
- What the module reads from the framework (the turn's trigger channel, the
  context manager's render stats and message window) is optional: on a host
  without it, the turn's channel comes from the newest message that woke the
  agent and recall uses the `excludeRecentTokens` fallback.

## Tested

| | |
|---|---|
| connectome-host | 0.9.0 (fork of main, `update-2026-10`), and type-checked against agent-framework 0.22.2 (main @ `b96e918`) |
| agent-framework | 0.21.0 |
| Date | 2026-10-18 (and running live since) |
| How | Loaded through the host's own `loadRecipe` → `loadExtensions` path against a running service, a local Qdrant 1.17.1 and real OpenAI `text-embedding-3-large` embeddings (via OpenRouter). Checked: a forced-think reply (delivered as `thoughts`) saved with the user's message under the configured speaker names; a user talking to someone else, another bot, and a stranger-started turn in a shared channel not saved; the user's mention in a shared channel saved without their earlier unaddressed message; heartbeat speech not saved; a stranger's turn not saved while the user's message waits in another channel; recall leaving out what the active tail still holds, returning it once the tail moved past, falling back to a token budget without render stats, labelling SillyTavern points `sillytavern`, honouring `limit`. Then deployed live: the first real turn (a forced-think reply) was archived as one chunk with both speakers. The service's search was also run read-only against a real collection shared with SillyTavern. |

## Files

- [`index.ts`](index.ts): the whole extension. It imports only types from
  `@animalabs/agent-framework`. Outside the agent's process, it makes HTTP
  calls to the memory-pool service and nothing else.
- `package.json` / `tsconfig.json`: type-checking only (`npm install --ignore-scripts && npm run check`).
