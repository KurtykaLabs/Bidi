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
  created_at  timestamptz DEFAULT now()
);

-- Enable realtime on both tables
ALTER PUBLICATION supabase_realtime ADD TABLE human_events;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_events;
