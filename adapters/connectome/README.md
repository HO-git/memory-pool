# memory-pool for Connectome

A [connectome-host](https://github.com/anima-research/connectome-host)
extension. It saves the agent's conversations with the users you list into
the memory pool, and can optionally give the agent a `memory--recall` tool.

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

| Config | Default | Meaning |
|---|---|---|
| `bot` | (required) | The agent's key under `bots` in the service's `config.json`. |
| `userIds` | (required) | Platform user ids whose conversations with the agent are saved. |
| `recall` | `false` | Give the agent a `memory--recall` tool. |
| `channels` | all | Only save in these channels (e.g. `["discord:{guildId}:{channelId}"]`). |
| `serviceUrl` | `http://127.0.0.1:3102` | Where the service listens. |
| `excludeRecentCount` | `25` | Recent messages left out of recall results, since they're already in context. |
| `requestTimeoutMs` | `3500` | Per-request timeout for service calls. |

Recall also has to be allowed in the service (`"recall": true` for that
agent in `config.json`). If it isn't, the tool says recall is off.

## What it does

- **Saving.** When a message from a listed user arrives, it is sent to the
  service straight away. The agent's replies are sent too, but only on turns
  a listed user started. Each save is tagged with the channel's platform
  (`discord`, `zulip`, …) as its `source`. Saving never delays a turn, and if
  the service is down the message is skipped with a log line.
- **Recall** (when enabled). The agent calls `memory--recall` with a query in
  its own words and gets back the closest past excerpts, with dates. Nothing
  is added to the prompt otherwise, so prompt caching is unaffected.

## Limits

- Replies the agent sends through an explicit tool (e.g. a Discord
  `send_message` tool) instead of plain speech are not captured.
- Only channel messages are saved, not DMs that arrive as push events.
- On a turn, the reply is attributed to the newest message that triggered a
  turn. If two listed users' messages wake the agent at once, the newer one
  decides whether the reply is saved.

## Tested

| | |
|---|---|
| connectome-host | 0.9.0 (main @ `32b5eb8`) |
| agent-framework | 0.21.0 (main @ `038b01f`) |
| Date | 2026-10-07 |
| How | Inside the real `AgentFramework` against a running service, a local Qdrant and the stub embedder: a listed user's message and the agent's reply were saved under the configured speaker names, another user's message was not, and recall left out messages still in context. Loaded through the host's own `loadRecipe` → `loadExtensions` path, and booted the host headless with the `mock` provider for a full turn with `memory--recall` in the request's tool list. Not yet run against a real model or embeddings provider. |

## Files

- [`index.ts`](index.ts): the whole extension. It imports only types from
  `@animalabs/agent-framework`. Outside the agent's process, it makes HTTP
  calls to the memory-pool service and nothing else.
- `package.json` / `tsconfig.json`: type-checking only (`npm install --ignore-scripts && npm run check`).
