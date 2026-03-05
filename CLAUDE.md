# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bidi is a CLI agent for a real-time chat system. It broadcasts keystrokes in real-time via Supabase channels and persists messages on Enter. In agent mode (default), it listens for user messages and auto-responds using the Claude Agent SDK with streaming output.

## Commands

```bash
npm test              # Run tests (vitest)
npm run build         # Compile TypeScript to dist/
npm start             # Run in agent mode (listens and responds)
npm run start:cli     # Run in interactive CLI mode
```

## Architecture

Single-package TypeScript project using ESM modules (`"type": "module"`).

**`src/index.ts`** — Entry point. Two modes controlled by `--cli` flag:
- **Agent mode** (default): subscribes to chat, auto-responds to user messages via Claude Agent SDK `query()`, streams tokens back as typing broadcasts
- **CLI mode**: raw stdin processing, character-by-character broadcast, sends on Enter

**`src/chat.ts`** — `Chat` class wrapping Supabase realtime. Handles:
- Channel subscription with postgres_changes listener on `messages` table
- Message deduplication via `sentMessages` Set (prevents echo)
- Typing broadcasts via channel broadcast events
- Exponential backoff reconnection (3s base, 60s max) with `disposed` flag to prevent reconnects after unsubscribe

**`src/agent.ts`** — Stream processing for Claude Agent SDK responses:
- `processAgentStream()` — async iteration over SDK messages, extracts text deltas and final assistant messages
- `processStreamDelta()` — trims leading newlines on first token
- `extractAssistantText()` — pulls text from content block arrays
- Session ID capture for conversation continuity

## Testing

Tests live next to source files (`*.test.ts`). Vitest with module-level mocks for Supabase. Uses `vi.useFakeTimers()` for reconnection timing tests.

## Environment

Requires `.env` with `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Copy from `.env.example`.
