# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bidi is a real-time agent that listens for human messages via Supabase Realtime and auto-responds using the Claude Agent SDK. Conversations are organized into channels with optional threads. All SDK events (thinking, tool use, text deltas, results) are broadcast per-channel, with milestone events persisted as rows in an `events` table under parent messages.

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
channels → threads → messages → events (persisted milestones)
                ↑                   ↳ streaming deltas broadcast-only
    top-level messages also live directly in channels
```

- Messages are containers (no `text` column) — content lives in child `events` rows
- Human messages have a single `text` event; agent messages have multiple events
- Threads link back to a root message; `session_id` on agent messages enables conversation continuity

**`src/index.ts`** — Entry point. Creates a `RealtimeListener`, subscribes to message INSERTs. On human message, fetches text event (with retry), creates agent message, streams response via Claude Agent SDK `query()`, persists milestone events, and updates session/thread metadata.

**`src/realtime.ts`** — `RealtimeListener` class wrapping Supabase Realtime. Handles:
- Global subscription with postgres_changes listener on `messages` table (no channel filter)
- `broadcastAgentEvent()` — broadcasts `AgentEvent` with `message_id` on `channel:{id}` channel
- Exponential backoff reconnection (3s base, 60s max) with `disposed` flag to prevent reconnects after unsubscribe
- Catch-up query on reconnect to recover messages missed during disconnect window
- Uses `removeChannel()` for clean channel teardown (avoids stale channel reuse)

**`src/db.ts`** — Database query helpers:
- `createMessage()` / `persistEvent()` — insert message and event rows
- `getMessageText()` — queries text event for a message
- `getThreadSessionId()` — looks up most recent agent session_id in a thread
- `createThread()` / `updateThreadActivity()` — thread lifecycle helpers
- `updateMessageSessionId()` — sets session_id on agent messages after stream completes
- `getHumanMessagesSince()` — catch-up query for reconnect recovery
- `getChannelSummary()` — fetches recent channel messages for thread context

**`src/agent.ts`** — Stream processing for Claude Agent SDK responses:
- `AgentEvent` — discriminated union of all event types (text_delta, thinking, tool_use, result, etc.)
- `processAgentStream()` — async iteration over SDK messages, emits `AgentEvent` for every SDK event, returns `AgentStreamResult`
- `processStreamEvent()` — maps raw SDK stream events to `AgentEvent` with block type tracking
- `processStreamDelta()` / `extractAssistantText()` — internal helpers

**`docs/realtime-events.md`** — Client spec documenting all event types, payloads, and Supabase subscription patterns.

**`supabase/migrations/`** — Database migrations:
- `001_event_tables.sql` — Original `human_events` and `agent_events` tables (superseded)
- `002_channels_threads_messages.sql` — Creates `channels`, `threads`, `messages`, `events` tables; drops old tables

## Testing

Tests live next to source files (`*.test.ts`). Vitest with module-level mocks for Supabase. Uses `vi.useFakeTimers()` for reconnection timing tests. Test files are excluded from `tsc` build via tsconfig.

## Environment

Requires `.env` with `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Copy from `.env.example`.
