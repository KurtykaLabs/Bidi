-- Simplify data model: drop threads table, move session_id to channels,
-- replace thread_id with self-referencing parent_message_id on messages.

ALTER TABLE channels ADD COLUMN session_id text;
ALTER TABLE messages ADD COLUMN parent_message_id uuid REFERENCES messages(id);
ALTER TABLE messages DROP COLUMN thread_id;
ALTER TABLE messages DROP COLUMN session_id;
DROP INDEX IF EXISTS idx_messages_thread;
DROP INDEX IF EXISTS idx_threads_channel;
DROP TABLE threads;
CREATE INDEX idx_messages_parent ON messages(parent_message_id, created_at);
