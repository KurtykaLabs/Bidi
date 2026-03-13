-- Channels, threads, messages, and events
CREATE TABLE channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        uuid NOT NULL REFERENCES channels(id),
  root_message_id   uuid NOT NULL,  -- FK added after messages table exists
  last_activity_at  timestamptz DEFAULT now(),
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  uuid NOT NULL REFERENCES channels(id),
  thread_id   uuid REFERENCES threads(id),
  role        text NOT NULL CHECK (role IN ('human', 'agent')),
  session_id  text,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages(id),
  type        text NOT NULL,
  payload     jsonb DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);

-- Deferred FK from threads.root_message_id to messages
ALTER TABLE threads ADD CONSTRAINT fk_root_message
  FOREIGN KEY (root_message_id) REFERENCES messages(id);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_threads_channel ON threads(channel_id, last_activity_at DESC);
CREATE INDEX idx_events_message ON events(message_id, created_at);

ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- Drop old tables
ALTER PUBLICATION supabase_realtime DROP TABLE human_events;
ALTER PUBLICATION supabase_realtime DROP TABLE agent_events;
DROP TABLE human_events;
DROP TABLE agent_events;
