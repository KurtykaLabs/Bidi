# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bidi is a real-time agent that listens for human messages via Supabase Realtime and auto-responds using the Claude Agent SDK. All SDK events (thinking, tool use, text deltas, results) are broadcast through a single `agent_event` channel, with milestone events persisted to a database.

## Commands

```bash
npm test              # Run tests (vitest)
npm run build         # Compile TypeScript to dist/
npm start             # Run agent (listens for human_events, responds via agent_events)
```

## Architecture

Single-package TypeScript project using ESM modules (`"type": "module"`).

**`src/index.ts`** — Entry point. Subscribes to `human_events` table, auto-responds via Claude Agent SDK `query()`. Each SDK event is broadcast and milestone events are persisted.

**`src/chat.ts`** — `Chat` class wrapping Supabase realtime. Handles:
- Channel subscription with postgres_changes listener on `human_events` table
- `broadcastAgentEvent()` — broadcasts `AgentEvent` on `"agent_event"` channel
- `persistAgentEvent()` — inserts milestone events (`assistant_message`, `tool_use_start`, `tool_use_summary`, `tool_result`, `result`) to `agent_events` table
- Exponential backoff reconnection (3s base, 60s max) with `disposed` flag to prevent reconnects after unsubscribe

**`src/agent.ts`** — Stream processing for Claude Agent SDK responses:
- `AgentEvent` — discriminated union of all event types (text_delta, thinking, tool_use, result, etc.)
- `processAgentStream()` — async iteration over SDK messages, emits `AgentEvent` for every SDK event, returns `AgentStreamResult`
- `processStreamEvent()` — maps raw SDK stream events to `AgentEvent` with block type tracking
- `processStreamDelta()` / `extractAssistantText()` — internal helpers

**`docs/realtime-events.md`** — Client spec documenting all event types, payloads, and Supabase subscription patterns.

**`supabase/migrations/001_event_tables.sql`** — Creates `human_events` and `agent_events` tables.

## Testing

Tests live next to source files (`*.test.ts`). Vitest with module-level mocks for Supabase. Uses `vi.useFakeTimers()` for reconnection timing tests. Test files are excluded from `tsc` build via tsconfig.

## Environment

Requires `.env` with `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Copy from `.env.example`.
