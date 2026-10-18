# memory-pool

One shared, embedded memory of your conversations with an agent, written by
every place you talk to it. It works today with **Connectome**, **ChapterX**
and **SillyTavern**, and any other interface can join over a small HTTP API.

memory-pool saves conversations as embeddings in a Qdrant collection, one per
agent, in exactly the format
[st-qdrant-memory](https://github.com/HO-git/st-qdrant-memory) uses. So the
same agent on Connectome, ChapterX and SillyTavern can share one collection,
and everything you say to it, wherever you said it, ends up in one searchable
place.

```
 Connectome resident ── extension ──┐
 ChapterX bot ───────── plugin ─────┼──► memory-pool service ──┐
 your own interface ─── HTTP ───────┘                          ├──► Qdrant collection (one per agent)
 SillyTavern ────────── st-qdrant-memory ──────────────────────┘
```

## What it's for

1. **An archive.** The main job is *saving*: every conversation with the
   people you configure is chunked, embedded and stored as it happens. The
   archive stays searchable from the service's web UI, from SillyTavern's
   memory viewer, or from anything that can query Qdrant, whether or not a
   model ever reads it back.
2. **One memory across interfaces.** An agent you reach through several
   interfaces keeps one continuous history instead of a separate one per app.
3. **Recall, if you want it.** Optionally, the agent gets a recall tool
   (`archive--recall` on Connectome, `recall` on ChapterX) and searches the
   pool with its own query when it wants to remember something.
   Nothing is added to the prompt automatically: no per-turn clutter, and
   prompt caching is unaffected. Recall is **off by default**.

## What's here

| Path | What it is |
|---|---|
| [`service/`](service/) | The memory-pool service: owns embeddings and Qdrant access, chunks and dedups incoming messages, and serves recall. Bun, no runtime dependencies, with a small web UI. |
| [`adapters/connectome/`](adapters/connectome/) | A [connectome-host](https://github.com/anima-research/connectome-host) extension. Loaded from the recipe; no fork needed. |
| [`adapters/chapterx/`](adapters/chapterx/) | A [ChapterX](https://github.com/antra-tess/chapterx) plugin, plus a small patch for the agent loop. |
| [`docs/clients.md`](docs/clients.md) | **Connecting another interface**: the HTTP API, and what an adapter needs to do. |
| [`docs/format.md`](docs/format.md) | The shared storage format, for clients that write to Qdrant directly. |

## Quick start

You need Qdrant, an embeddings API key, and [Bun](https://bun.sh).

**1. Run the service.**

```bash
cd service
cp .env.example .env               # Qdrant URL, embeddings key, web UI login
cp config.example.json config.json # one entry per agent
bun install
bun src/index.ts
```

Each entry under `bots` in `config.json` is one agent: which Qdrant
collection it writes to, which embedding model built that collection, and the
speaker names to use (`selfSpeaker` for the agent, `speakerAliases` mapping
user ids to names).

- **Starting fresh:** pick a new collection name. It is created on the first
  save.
- **Sharing with SillyTavern:** point `collection` at the collection
  st-qdrant-memory already keeps for this agent (SillyTavern calls it a
  character), set `embeddingModel` and `embeddingDimensions` to what built
  it, `selfSpeaker` to the agent's name there, and map your user id to your
  SillyTavern persona name in `speakerAliases`. Take a Qdrant snapshot first
  (the web UI has a button).

`config.json` is hot-reloaded. `recall` and `autoSave` are independent
switches per agent, and `global.paused` stops everything at once.

**2. Connect your interfaces.** Follow the adapter READMEs:
[Connectome](adapters/connectome/README.md) ·
[ChapterX](adapters/chapterx/README.md).

## Connecting another interface

The adapters are thin: everything they do goes through two HTTP calls, `POST
/save` and `POST /retrieve`. Anything that can make those calls can join the
pool: a [Hermes](https://github.com/NousResearch/hermes-agent) agent, a
custom bot, a script that imports old chat logs. Each interface tags what it
writes with its own `source`, so you can always tell where a memory came from.
[`docs/clients.md`](docs/clients.md) has the API and a checklist. New adapters
are welcome as pull requests under `adapters/`.

## Who gets saved

Only conversations between the agent and the users you list (by platform
user id). On Connectome, a listed user's messages are saved when the agent
replies to them, together with the reply, in the channel where it happened:
what they say to other people or other bots never enters the pool. Other
people in the channel, and the agent's autonomous activity (heartbeats,
timers), stay out too. The service dedups by message id, so re-sending is
harmless. See each adapter's README for its exact rule.

## Web UI and endpoints

The service listens on loopback (`127.0.0.1:3102` by default).

- `POST /save`, `POST /retrieve`, `GET /healthz`: for adapters, no auth. Keep
  the service on loopback or a private network.
- `/ui`: a control panel behind basic auth (`UI_USER`/`UI_PASSWORD`). Per-agent
  switches (hot-reloaded), a memory browser with search and delete, bulk delete
  of everything memory-pool wrote, snapshots, and an activity log. Reach it
  through an SSH tunnel: `ssh -L 3102:127.0.0.1:3102 <your-server>`.

[`service/memory-pool.service`](service/memory-pool.service) is an example
systemd user unit.

## Safety notes

- **Snapshot before sharing a collection.** memory-pool writes into the
  collection you name. Every point it writes carries a `source` field, so its
  writes can be told apart from SillyTavern's and bulk-deleted from the web
  UI, but a snapshot is the real undo.
- **Embeddings must match.** Vectors from a different model or dimension
  don't mix with an existing collection. Use whatever built it.
- **Keep Qdrant private.** Reach a remote Qdrant over a private network
  (a VPN or a cloud private network), not the public internet.
- **Everything fails open.** If the service or Qdrant is down, saves are
  skipped and recall says memory is unavailable; the agent carries on.

## Status

Extracted from a deployment that has run since July 2026: a Connectome
resident and two ChapterX bots sharing collections with SillyTavern. The
Connectome module in this form (saving only user↔agent turns, recall as a
tool, the service's restart-safe save journal) has run live in that
deployment since 2026-10-18, against connectome-host 0.9.0 / agent-framework
0.21.0, a remote Qdrant 1.17.1 and real OpenAI embeddings; it also
type-checks against agent-framework 0.22.2. The ChapterX adapter was last
tested on 2026-10-07 with a local Qdrant and a stub embedder. Each adapter's
README has the details.

## License

[MIT](LICENSE).
