# Bidi

CLI agent for the Bidi chat system. Type characters and they broadcast in real-time via Supabase. Press Enter to save the message.

## Setup

1. Copy env and add your Supabase credentials:
   ```
   cp .env.example .env
   ```

2. Create the `messages` table in your Supabase SQL Editor:
   ```sql
   create table messages (
     id uuid default gen_random_uuid() primary key,
     text text not null,
     sender text not null default 'agent',
     created_at timestamptz default now()
   );
   ```

3. Install and run:
   ```
   npm install
   node index.js
   ```

## Usage

- Type characters — broadcasted live on the `chat` channel
- Enter — saves message to the `messages` table
- Backspace — deletes last character
- Ctrl+C — quit
