# Realtime Events Spec

Client reference for consuming Bidi agent events via Supabase Realtime.

## Channel

All events flow through a single Supabase channel: `"chat"`.

### Subscribing to agent events (broadcast)

```typescript
const channel = supabase.channel("chat");

channel
  .on("broadcast", { event: "agent_event" }, ({ payload }) => {
    const event: AgentEvent = payload;
    // event.type determines the shape — see Event Types below
  })
  .subscribe();
```

### Subscribing to persisted events (postgres_changes)

```typescript
channel
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "agent_events" },
    ({ new: row }) => {
      // row.type, row.payload, row.session_id, row.created_at
    }
  )
  .subscribe();
```

### Sending a human message

Insert into `human_events` — the agent subscribes to this table:

```typescript
await supabase.from("human_events").insert({
  type: "message",
  payload: { text: "Hello agent" },
});
```

---

## Event Types

Every broadcast payload has the shape `{ type: string, ...fields }`. The `type` field determines which additional fields are present.

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
| `tool_use_summary` | `summary: string` | No | Tool use summary |

### Session and lifecycle

| Type | Fields | Persisted | Description |
|------|--------|-----------|-------------|
| `session_id` | `id: string` | No | Session ID for conversation continuity |
| `result` | `session_id?: string`, `duration_ms?: number` | Yes | Stream completed |
| `system` | `message: string`, `subtype?: string` | No | System-level message |
| `unknown` | `raw: any` | No | Unrecognized SDK event (passthrough) |

---

## Event Sequencing

A typical agent response produces events in this order:

```
session_id
thinking_start
thinking_delta (repeated)
thinking_stop
text_delta (repeated)
tool_use_start
tool_use_delta (repeated)
tool_use_stop
tool_progress (repeated, during execution)
tool_result
text_delta (repeated, after tool)
assistant_message
result
```

Not all events appear in every response. A simple text reply may only produce:

```
session_id
text_delta (repeated)
assistant_message
result
```

---

## Persistence

Only milestone events are inserted into the `agent_events` table:

- `assistant_message`
- `tool_use_start`
- `tool_result`
- `result`

All other events are broadcast-only (ephemeral). Clients that connect mid-stream can query `agent_events` for history and rely on broadcasts for live updates.

---

## Database Tables

### `human_events`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `type` | `text` | Event type (e.g. `"message"`) |
| `payload` | `jsonb` | Event data (e.g. `{ "text": "Hello" }`) |
| `created_at` | `timestamptz` | Auto-generated |

### `agent_events`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Auto-generated |
| `type` | `text` | Event type |
| `payload` | `jsonb` | Event data |
| `session_id` | `text` | Conversation session ID |
| `created_at` | `timestamptz` | Auto-generated |

---

## Broadcast Payload Shape

All broadcasts use event name `"agent_event"` on the `"chat"` channel:

```json
{
  "type": "broadcast",
  "event": "agent_event",
  "payload": {
    "type": "text_delta",
    "text": "Hello",
    "sender": "agent"
  }
}
```

The `sender` field is always `"agent"` for agent-originated events.
