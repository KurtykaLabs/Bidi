# Bidi

Real-time agent that listens for human messages via Supabase Realtime and auto-responds using the Claude Agent SDK, streaming all events (thinking, tool use, text, results) back through a single broadcast channel.

## Setup

1. Copy env and add your Supabase credentials:
   ```
   cp .env.example .env
   ```

2. Run the migration in your Supabase SQL Editor (or via `supabase db push`):
   ```
   supabase/migrations/001_event_tables.sql
   ```

3. Install and run:
   ```
   npm install
   npm start
   ```

## Architecture

See [`docs/realtime-events.md`](docs/realtime-events.md) for the full client spec.

- **`human_events`** table — clients insert messages here to talk to the agent
- **`agent_events`** table — milestone events (assistant messages, tool use, results) are persisted here
- **`agent_event`** broadcast — all SDK events are broadcast in real-time on the `chat` channel
