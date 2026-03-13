# Backend Refactor: Client Notes

Summary of backend changes for client implementation.

## Data model

The old `human_events` and `agent_events` tables are gone. They've been replaced with a normalized schema:

```
channels → messages → events
    ↑          ↑          ↳ streaming deltas broadcast-only
    |          ↳ parent_message_id (self-referencing for replies)
    ↳ session_id (one Claude conversation per channel)
```

### Tables

**`channels`** — top-level conversation containers

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `name` | `text` | Channel name |
| `session_id` | `text` (nullable) | Claude SDK session ID for conversation continuity |
| `created_at` | `timestamptz` | Auto-generated |

**`messages`** — containers for content, no `text` column

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `channel_id` | `uuid` (FK → channels) | Parent channel |
| `parent_message_id` | `uuid` (FK → messages, nullable) | Parent message (null = top-level) |
| `role` | `text` | `'human'` or `'agent'` |
| `created_at` | `timestamptz` | Auto-generated |

**`events`** — actual content lives here, under messages

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `message_id` | `uuid` (FK → messages) | Parent message |
| `type` | `text` | Event type |
| `payload` | `jsonb` | Event data |
| `created_at` | `timestamptz` | Auto-generated |

Key concept: **messages are containers**. A human message has a single `text` event. An agent message has multiple events (assistant_message, tool_use_start, tool_result, etc.). Content is always in `events`, never on the message row itself.

## Client operations

### Sending a human message

Use the `send_message` RPC:

```typescript
const { data: messageId } = await supabase.rpc("send_message", {
  p_channel_id: channelId,
  p_text: "Hello agent",
  p_parent_message_id: parentMessageId ?? undefined, // optional
});
```

The backend picks up the message INSERT via realtime and auto-responds.

### Replying to a message

Set `p_parent_message_id` to the message you're replying to:

```typescript
const { data: messageId } = await supabase.rpc("send_message", {
  p_channel_id: channelId,
  p_text: "Follow up question",
  p_parent_message_id: originalMessageId,
});
```

### Subscribing to agent events (broadcast)

Subscribe to `channel:{channelId}` for streaming events:

```typescript
supabase.channel(`channel:${channelId}`)
  .on("broadcast", { event: "agent_event" }, ({ payload }) => {
    // payload.type — determines the event shape
    // payload.message_id — links to the parent agent message
  })
  .subscribe();
```

### Subscribing to new messages (postgres_changes)

Listen for new message rows in a channel:

```typescript
supabase.channel(`channel:${channelId}`)
  .on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `channel_id=eq.${channelId}`,
    },
    ({ new: row }) => {
      // row.id, row.channel_id, row.parent_message_id, row.role
    }
  )
  .subscribe();
```

### Loading message history

Messages are containers — join through events to get content:

```typescript
const { data } = await supabase
  .from("messages")
  .select("id, role, parent_message_id, created_at, events(type, payload, created_at)")
  .eq("channel_id", channelId)
  .order("created_at", { ascending: true });
```

For a human message, look for the `text` event. For an agent message, events will include `assistant_message`, `tool_use_start`, `tool_result`, `tool_use_summary`, `result`, etc.

## Broadcast event types

Every broadcast payload has the shape `{ type: string, message_id: string, ...fields }`.

### Text streaming

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `text_delta` | `text` | No | Incremental text token |
| `assistant_message` | `text` | Yes | Final assembled assistant message |

### Thinking

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `thinking_start` | _(none)_ | No | Thinking block began |
| `thinking_delta` | `text` | No | Incremental thinking token |
| `thinking_stop` | _(none)_ | No | Thinking block ended |

### Tool use

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `tool_use_start` | `name`, `id` | Yes | Tool invocation began |
| `tool_use_delta` | `input_json` | No | Incremental tool input JSON |
| `tool_use_stop` | _(none)_ | No | Tool input complete |
| `tool_progress` | `progress` | No | Tool execution progress |
| `tool_result` | `tool_use_id`, `content` | Yes | Tool execution result |
| `tool_use_summary` | `summary` | Yes | Tool use summary |

### Session and lifecycle

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `session_id` | `id` | No | Session ID for continuity |
| `result` | `session_id?`, `duration_ms?` | Yes | Stream completed |
| `system` | `message`, `subtype?` | No | System-level message |
| `unknown` | `raw` | No | Unrecognized event (passthrough) |

"Persisted" means the event is saved as a row in the `events` table under the agent message. Non-persisted events are broadcast-only (streaming deltas, thinking, etc.).

## Things to know

1. **Subscribe before sending.** The backend creates broadcast channels lazily on first agent response. Subscribe to `channel:{channelId}` before inserting a human message to avoid missing early events.

2. **New channels work immediately.** The backend listens globally — no restart needed when a new channel is created.

3. **Replies get context automatically.** When a reply starts in a channel with no prior session, the backend fetches recent channel messages and includes them as context for the agent. Subsequent messages in the same channel resume the Claude session.

4. **`session_id` on channels.** After an agent finishes responding, the channel gets a `session_id`. This is used internally for session resumption — clients don't need to manage it.
