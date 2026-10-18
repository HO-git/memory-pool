# Connecting another interface

Any interface that can make HTTP calls can share an agent's memory pool: an
agent framework such as [Hermes](https://github.com/NousResearch/hermes-agent),
a custom bot, a voice front-end, a script that imports old chat logs. The
Connectome and ChapterX adapters in this repo are a couple of hundred lines
each, and almost all of that is reading their host's message format.

## The API

The service listens on loopback by default (`http://127.0.0.1:3102`). These
endpoints have no auth, so keep the service on loopback or a private network.

### `POST /save`

Report messages for saving. The service buffers them into chunks (a few
consecutive messages from one conversation), embeds each chunk and writes it
to the agent's collection.

```json
{
  "bot": "my-agent",
  "source": "hermes",
  "messages": [
    {
      "speaker_kind": "user",
      "user_id": "u-123",
      "speaker_name": "Sam",
      "text": "Did we ever finish the lighthouse story?",
      "message_id": "hermes-msg-8812",
      "ts": 1791300000000,
      "channel_id": "hermes:main"
    },
    {
      "speaker_kind": "self",
      "text": "Not yet. We stopped where the keeper finds the second key.",
      "message_id": "hermes-msg-8813",
      "ts": 1791300004000,
      "channel_id": "hermes:main"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `bot` | The agent's key under `bots` in the service's `config.json`. |
| `source` | Your interface's name, stored on every chunk you write (letters, digits, `_.-`, up to 40 characters). Optional; defaults to `"discord"` for the original adapters. |
| `speaker_kind` | `"user"` for a person, `"self"` for the agent. |
| `user_id` | The person's id on your platform. If it is in `speakerAliases`, that name is used; otherwise `speaker_name`. |
| `speaker_name` | Fallback display name for a person. |
| `text` | The message as written. |
| `message_id` | Unique per agent, and stable: the service dedups on it, so re-sending a message is harmless. Prefix it with your source if your ids could collide with another interface's. |
| `ts` | Unix milliseconds. |
| `channel_id`, `guild_id` | Optional: where the conversation happened. Messages are chunked per source and channel, so different conversations never interleave. |

Response: `{ "buffered": <n> }`, the number of messages newly accepted. When
saving is switched off for the agent, `{ "buffered": 0, "skipped": true }`.

### `POST /retrieve`

Search the agent's pool. Allowed only when `recall` is on for that agent.

```json
{
  "bot": "my-agent",
  "query_text": "the lighthouse story",
  "exclude_message_ids": ["hermes-msg-8812", "hermes-msg-8813"],
  "limit": 5
}
```

`exclude_message_ids` should list the messages already in the agent's
context, so recall doesn't return what it can already see. `limit` defaults
to the agent's `memoryLimit`.

Response: `{ "formatted": "...", "hits": [...], "count": <n> }`. `formatted`
is a ready-to-show text block of the matches, in st-qdrant-memory's style;
`hits` has each match's text, score, speakers, timestamp and message ids.
With recall off: `{ "formatted": "", "hits": [], "count": 0, "skipped": true }`.
On an internal error the call still answers, with an `error` field and no
hits.

### `GET /healthz`

`{ "ok": true }` when the service is up.

## What an adapter should do

1. **Decide who gets saved.** The existing adapters save only conversations
   with users listed in their config: those users' messages, and the
   agent's replies on turns those users started. Autonomous activity and
   other people stay out.
2. **Save as messages happen.** Call `/save` without waiting on the result,
   so the agent is never held up. Re-sending is harmless, so an adapter that
   can only see a window of recent messages can report the whole window
   every time.
3. **Use stable message ids.** A platform's own ids are best. For the agent's
   own speech, derive an id from the message it answers (the Connectome
   adapter uses `self-<trigger id>-<n>`).
4. **Offer recall as a tool, if at all.** Let the agent search with its own
   words, and pass the message ids already in its context as
   `exclude_message_ids`. Return a short "no matching memories" or "memory
   is unavailable" instead of failing the tool.
5. **Fail open.** If the service is unreachable, log it and carry on.

A new adapter is welcome as a pull request under `adapters/<interface>/`,
with a README saying what it saves, how to install it and what it was tested
on.

## Writing to Qdrant directly

Clients that would rather write chunks straight into Qdrant can, as long as
they follow [the storage format](format.md). Going through the service is
simpler: chunking, dedup, embeddings and speaker names are handled for you.
