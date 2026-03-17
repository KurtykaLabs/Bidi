# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bidi is a real-time agent that listens for human messages via Supabase Realtime and auto-responds using the Claude Agent SDK. Conversations are organized into channels (one Claude session per channel). Messages can be replies via `parent_message_id`. All SDK events (thinking, tool use, text deltas, results) are broadcast per-channel, with milestone events persisted as rows in an `events` table under parent messages.

## Commands

```bash
npm test              # Run tests (vitest)
npm run build         # Compile TypeScript to dist/
npm start             # Run agent (subscribes to all channels, responds to human messages)
```

## Architecture

Single-package TypeScript project using ESM modules (`"type": "module"`).

### Data model

```
channels → messages → events (persisted milestones)
    ↑          ↑          ↳ streaming deltas broadcast-only
    |          ↳ parent_message_id (self-referencing for replies)
    ↳ session_id (one Claude conversation per channel)
```

- Messages are containers (no `text` column) — content lives in child `events` rows
- Human messages have a single `text` event; agent messages have multiple events
- `session_id` lives on channels for conversation continuity
- Replies use `parent_message_id` (self-referencing FK on messages)

**`src/index.ts`** — Entry point. Creates a `RealtimeListener`, subscribes to message INSERTs. On human message, fetches text event (with retry), creates agent message, streams response via Claude Agent SDK `query()`, persists milestone events, and updates channel session.

**`src/realtime.ts`** — `RealtimeListener` class wrapping Supabase Realtime. Handles:
- Global subscription with postgres_changes listener on `messages` table (no channel filter)
- `broadcastAgentEvent()` — broadcasts `AgentEvent` with `message_id` on `channel:{id}` channel
- Exponential backoff reconnection (3s base, 60s max) with `disposed` flag to prevent reconnects after unsubscribe
- Catch-up query on reconnect to recover messages missed during disconnect window
- Uses `removeChannel()` for clean channel teardown (avoids stale channel reuse)

**`src/db.ts`** — Database query helpers:
- `createMessage()` / `persistEvent()` — insert message and event rows
- `getMessageText()` — queries text event for a message
- `getChannelSessionId()` / `updateChannelSessionId()` — read/write session_id on channels
- `getHumanMessagesSince()` — catch-up query for reconnect recovery
- `getChannelSummary()` — fetches recent top-level channel messages for context

**`src/agent.ts`** — Stream processing for Claude Agent SDK responses:
- `AgentEvent` — discriminated union of all event types (text_delta, thinking, tool_use, result, etc.)
- `processAgentStream()` — async iteration over SDK messages, emits `AgentEvent` for every SDK event, returns `AgentStreamResult`
- `processStreamEvent()` — maps raw SDK stream events to `AgentEvent` with block type tracking
- `processStreamDelta()` / `extractAssistantText()` — internal helpers

**`docs/realtime-events.md`** — Client spec documenting all event types, payloads, and Supabase subscription patterns.

**`supabase/migrations/`** — Database migrations:
- `001_event_tables.sql` — Original `human_events` and `agent_events` tables (superseded)
- `002_channels_threads_messages.sql` — Creates `channels`, `threads`, `messages`, `events` tables; drops old tables
- `003_simplify_data_model.sql` — Drops `threads` table, moves `session_id` to channels, replaces `thread_id` with `parent_message_id`

## Testing

Tests live next to source files (`*.test.ts`). Vitest with module-level mocks for Supabase. Uses `vi.useFakeTimers()` for reconnection timing tests. Test files are excluded from `tsc` build via tsconfig.

## Skills

- Before writing or modifying Supabase queries, schema, migrations, or RLS policies, use the `supabase-postgres-best-practices` skill for Postgres optimization guidance.
- Before writing or modifying code that uses the Claude API or Anthropic SDK, use the `claude-api` skill.

## Environment

Requires `.env` with `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Copy from `.env.example`.
