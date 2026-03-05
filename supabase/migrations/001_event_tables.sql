-- Human events: messages from the user
CREATE TABLE human_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz DEFAULT now()
);

-- Agent events: persisted milestone events only
CREATE TABLE agent_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  session_id  text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX idx_agent_events_session_id ON agent_events (session_id);

-- Enable realtime on both tables
ALTER PUBLICATION supabase_realtime ADD TABLE human_events;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_events;
