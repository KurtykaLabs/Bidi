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
- Stale-channel guard pattern: `subscribe()` captures `currentChannel` in a closure and bails if `this.listenerChannel` has changed since

**Supabase channel deduplication gotcha:** `supabase.channel(topic)` returns the *existing* channel instance if one with that topic already exists (see `RealtimeClient.channel()` in `@supabase/realtime-js`). Calling `.subscribe()` on a reused channel throws `"tried to subscribe multiple times"` because `joinedOnce` is never reset. Additionally, `RealtimeClient._remove(channel)` filters by topic name (`c.topic !== channel.topic`), so removing an old channel will also remove a new channel if they share the same topic. **Always use a unique topic for reconnection** (e.g. `` `messages:all:${Date.now()}` ``) to guarantee a fresh channel instance.

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

**`src/analytics.ts`** — PostHog telemetry wrapper (on by default, disable with `BIDI_TELEMETRY=off`):
- `initAnalytics()` / `setDistinctId()` — initialize client, set agent ID after auth
- `trackEvent()` / `captureError()` — event capture and error tracking
- `shutdownAnalytics()` — flush pending events on exit

**`docs/realtime-events.md`** — Client spec documenting all event types, payloads, and Supabase subscription patterns.

### E2E encryption (whitepaper conformance)

Per the whitepaper at bidi.sh/whitepaper, content at rest in Supabase is encrypted with libsodium primitives (Argon2id-wrapped seed → Curve25519 keypair → sealed-box-wrapped per-space key → XSalsa20-Poly1305 secretbox for content). Implementation lives in `src/crypto.ts`, `src/keyring.ts`, `src/passphrase.ts`. Encrypted columns: `agents.name`, `channels.name`, `events.payload`. The CLI caches the unwrapped space key at `~/.bidi/spaces/<spaceId>.json` (mode 0o600) so users only enter their passphrase on fresh installs / cache misses.

**Realtime broadcasts are encrypted.** `RealtimeListener` (constructed with the keyring) wraps every `agent_event` and `channel_event` payload in the same unified envelope as persisted content (`{ data: base64(version||nonce||ciphertext) }`). Receivers decrypt with the space key. See `docs/realtime-events.md` for the wire format clients consume. Tests verify that no plaintext appears in the wire payload.

**No plaintext name window on agent creation.** New agents go through `findExistingAgent` → `promptAgentName` → generate space key → `encryptString(name)` → `createAgent(encryptedName)` → `commitSpace`. The agent row never exists in the database with a plaintext name — even briefly — so WAL, audit logs, and replicas only ever observe the ciphertext. The legacy `update_agent` RPC is kept only for the `/rename` command.

**Analytics hygiene:** never send a value that's encrypted-at-rest (agent name, channel name, decrypted event content) to PostHog. `trackEvent` / `captureError` properties must be UUIDs, timestamps, counts, or technical enums only.

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

Optional: Set `BIDI_TELEMETRY=off` to disable PostHog analytics (on by default).
