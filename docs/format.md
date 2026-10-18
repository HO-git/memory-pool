# The shared storage format

memory-pool and [st-qdrant-memory](https://github.com/HO-git/st-qdrant-memory)
read and write the same Qdrant collections. This is what keeps them
compatible. Anything else that follows it can share the pool too, though
most interfaces are better off going through the service's
[HTTP API](clients.md).

## Collections

One collection per agent (st-qdrant-memory keeps one per SillyTavern
character). Vectors are cosine-distance embeddings, and
every writer must use the same embedding model and dimensions as whatever
created the collection (st-qdrant-memory's default is
`text-embedding-3-large`, 3072 dimensions).

## Points

Each point is one **chunk**: a few consecutive messages from one conversation.

Chunk text, dated by its oldest message:

```
[YYYY-MM-DD]
Speaker: message text
Speaker: message text
```

Payload:

| Field | Type | Meaning |
|---|---|---|
| `text` | string | The chunk text above. |
| `speakers` | string | Comma-separated speaker names in the chunk. |
| `messageCount` | number | Messages in the chunk. |
| `timestamp` | number | Unix ms of the oldest message. |
| `messageIds` | string | Comma-separated platform message ids; used to dedup, and to leave out chunks whose messages are already in the reader's context. |
| `isChunk` | `true` | st-qdrant-memory's chunk marker. |
| `source` | string | memory-pool only: which interface wrote the point (`"discord"`, `"hermes"`, …). SillyTavern's points have no `source`; st-qdrant-memory ignores the field. It lets memory-pool's points be filtered and bulk-deleted. |
| `channelId`, `guildId` | string | memory-pool only, optional: where the conversation happened. |

## Speaker names

For a shared pool to read as one history, the names must match across
writers: one name for the agent (`selfSpeaker` in the service config; when
sharing with SillyTavern, its character name there), and one name per person
(`speakerAliases`, keyed by user id; when sharing with SillyTavern, their
persona name).

## Recall output

`POST /retrieve` returns the hits plus a `formatted` block in
st-qdrant-memory's style:

```
[Past chat memories]

• Conversation (Speaker A, Speaker B): "[YYYY-MM-DD] Speaker A: … Speaker B: …" (score: NN%)
```
