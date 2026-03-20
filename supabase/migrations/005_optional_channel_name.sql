-- Make channel name optional with a default, since auto-naming
-- generates the name from the first message via Haiku.
-- Names must be lowercase with underscores only (no spaces).
ALTER TABLE channels ALTER COLUMN name SET DEFAULT 'new_channel';
ALTER TABLE channels ALTER COLUMN name DROP NOT NULL;
ALTER TABLE channels ADD CONSTRAINT channel_name_format
  CHECK (name ~ '^[a-z0-9_]+$');

-- Update create_channel to allow omitting the name
CREATE OR REPLACE FUNCTION create_channel(p_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO channels (name) VALUES (COALESCE(p_name, 'new_channel')) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;
