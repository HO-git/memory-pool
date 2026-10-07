# memory-pool for ChapterX

Two [ChapterX](https://github.com/antra-tess/chapterx) tool plugins, enabled
independently:

- **`memory-pool`** saves the bot's conversations with the users you list into
  the memory pool. It adds nothing to the bot's context.
- **`memory-pool-recall`** (optional) gives the bot a `recall` tool to search
  the pool.

## Install

ChapterX loads plugins from its own source tree, so installing takes a file
copy and a small patch:

```bash
cp memory-pool.ts /path/to/chapterx/src/tools/plugins/
cd /path/to/chapterx
git apply /path/to/memory-pool/adapters/chapterx/chapterx.patch
npm run build
```

The patch ([`chapterx.patch`](chapterx.patch), 25 lines) registers both
plugins and makes the agent loop hand `memory-pool` the recent messages with
their author ids and bot flags, which it needs to tell who started an
activation. It was made against ChapterX main `5d45845` (2026-10-02).

## Configure a bot

In the bot's YAML:

```yaml
tool_plugins: [memory-pool]            # add memory-pool-recall for the recall tool
plugin_config:
  memory-pool:
    bot: my-agent                      # the agent's key in the service's config.json
    user_ids: ['<your user id>']       # whose conversations are saved
    service_url: http://127.0.0.1:3102
    recent_messages: 30                # how far back each activation reports
    request_timeout_ms: 3500
```

`memory-pool-recall` reads its settings from `plugin_config.memory-pool`, so it
needs no config of its own. Recall also has to be allowed in the service
(`"recall": true` for that agent).

## What it does

- **Saving.** On each activation started by a listed user, the plugin reports
  that user's and the bot's recent messages to the service. The service
  dedups by message id, so overlapping windows are harmless. Activations
  started by anyone else, or by timers, save nothing.
- **Recall** (with `memory-pool-recall`). The bot calls `recall` with a query
  in its own words and gets back the closest past excerpts, with dates.
  Messages that were in context at the last activation in that channel are
  left out.

## Tested

| | |
|---|---|
| ChapterX | main @ `5d45845` (2026-10-02) |
| Date | 2026-10-07 |
| How | The patch applies cleanly and the build type-checks with no new errors (upstream main has 3 pre-existing errors in `src/llm/membrane/adapter.ts`). Both plugins were driven directly against a running service, a local Qdrant and the stub embedder: a listed user's activation saved the user's and bot's messages, a stranger's activation saved nothing, and recall found the saved chunk from another channel and left it out in the channel where it was still in context. Not yet run inside a live ChapterX bot in this form. |
