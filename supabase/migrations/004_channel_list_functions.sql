-- Channel list and creation functions

CREATE OR REPLACE FUNCTION list_channels()
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  last_activity_at timestamptz
) LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    c.name,
    c.created_at,
    COALESCE(
      (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id),
      c.created_at
    ) AS last_activity_at
  FROM channels c
  ORDER BY last_activity_at DESC;
$$;

CREATE OR REPLACE FUNCTION create_channel(p_name text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO channels (name) VALUES (p_name) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;
