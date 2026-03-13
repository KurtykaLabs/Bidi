# Realtime Events Spec

Client reference for consuming Bidi agent events via Supabase Realtime.

## Channels

Conversations are organized into channels. Each channel has its own Supabase Realtime channel named `channel:{channelId}`.

### Subscribing to agent events (broadcast)

```typescript
const channel = supabase.channel(`channel:${channelId}`);

channel
  .on("broadcast", { event: "agent_event" }, ({ payload }) => {
    // payload.type determines the shape — see Event Types below
    // payload.message_id links to the parent message
  })
  .subscribe();
```

### Subscribing to new messages (postgres_changes)

```typescript
channel
  .on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `channel_id=eq.${channelId}`,
    },
    ({ new: row }) => {
      // row.id, row.channel_id, row.thread_id, row.role, row.session_id
    }
  )
  .subscribe();
```

### Sending a human message

Create a message row, then insert a text event under it:

```typescript
const { data: msg } = await supabase
  .from("messages")
  .insert({
    channel_id: channelId,
    role: "human",
    thread_id: threadId ?? undefined, // optional
  })
  .select("id")
  .single();

await supabase.from("events").insert({
  message_id: msg.id,
  type: "text",
  payload: { text: "Hello agent" },
});
```

### Creating a thread

A thread is started from an existing message (the root):

```typescript
const { data: thread } = await supabase
  .from("threads")
  .insert({
    channel_id: channelId,
    root_message_id: rootMessageId,
  })
  .select("id")
  .single();
```

Subsequent messages in the thread set `thread_id` to this value.

---

## Event Types

Every broadcast payload has the shape `{ type: string, message_id: string, ...fields }`. The `type` field determines which additional fields are present.

### Text streaming

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `text_delta` | `text: string` | No | Incremental text token |
| `assistant_message` | `text: string` | Yes | Final assembled assistant message |

### Thinking

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `thinking_start` | _(none)_ | No | Extended thinking block began |
| `thinking_delta` | `text: string` | No | Incremental thinking token |
| `thinking_stop` | _(none)_ | No | Extended thinking block ended |

### Tool use

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `tool_use_start` | `name: string`, `id: string` | Yes | Tool invocation began |
| `tool_use_delta` | `input_json: string` | No | Incremental tool input JSON |
| `tool_use_stop` | _(none)_ | No | Tool input complete |
| `tool_progress` | `progress: string` | No | Tool execution progress update |
| `tool_result` | `tool_use_id: string`, `content: string` | Yes | Tool execution result |
| `tool_use_summary` | `summary: string` | Yes | Tool use summary |

### Session and lifecycle

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `session_id` | `id: string` | No | Session ID for conversation continuity |
| `result` | `session_id?: string`, `duration_ms?: number` | Yes | Stream completed |
| `system` | `message: string`, `subtype?: string` | No | System-level message |
| `unknown` | `raw: any` | No | Unrecognized SDK event (passthrough) |

---

## Data Model

```
channels → threads → messages → events (persisted milestones)
                ↑                   ↳ streaming deltas broadcast-only
    top-level messages also live directly in channels
```

- Messages can be top-level in a channel (no thread) or belong to a thread
- Starting a thread from a message makes that message the thread's root
- Messages are containers — no `text` column; content lives in child events
- Human messages contain a single `text` event
- Agent messages contain multiple events (text, tool uses, results)

---

## Database Tables

### `channels`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `name` | `text` | Channel name |
| `created_at` | `timestamptz` | Auto-generated |

### `threads`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `channel_id` | `uuid` (FK) | Parent channel |
| `root_message_id` | `uuid` (FK) | Message that started the thread |
| `last_activity_at` | `timestamptz` | Updated on new messages |
| `created_at` | `timestamptz` | Auto-generated |

### `messages`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `channel_id` | `uuid` (FK) | Parent channel |
| `thread_id` | `uuid` (FK, nullable) | Thread (null = top-level) |
| `role` | `text` | `'human'` or `'agent'` |
| `session_id` | `text` (nullable) | Claude SDK session ID |
| `created_at` | `timestamptz` | Auto-generated |

### `events`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `message_id` | `uuid` (FK) | Parent message |
| `type` | `text` | Event type |
| `payload` | `jsonb` | Event data |
| `created_at` | `timestamptz` | Auto-generated |

---

## Event Payload Examples

```jsonc
// Human text event
{ "type": "text", "payload": { "text": "Hello agent" } }

// Agent text event (final)
{ "type": "text", "payload": { "text": "Here's my response..." } }

// Tool use start
{ "type": "tool_use_start", "payload": { "name": "bash", "id": "tool_123" } }

// Tool result
{ "type": "tool_result", "payload": { "tool_use_id": "tool_123", "content": "..." } }

// Tool use summary
{ "type": "tool_use_summary", "payload": { "summary": "Ran bash command..." } }

// Result (stream complete)
{ "type": "result", "payload": { "duration_ms": 5432 } }
```

---

## Broadcast Payload Shape

All broadcasts use event name `"agent_event"` on the `channel:{channelId}` channel:

```json
{
  "type": "broadcast",
  "event": "agent_event",
  "payload": {
    "type": "text_delta",
    "text": "Hello",
    "message_id": "msg-uuid"
  }
}
```

The `message_id` field links the broadcast event to its parent agent message.
