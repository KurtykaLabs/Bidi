-- App-facing functions for spaces and channels.
-- list_spaces: returns spaces the current user belongs to.
-- create_channel: updated to accept a space_id and verify membership.

CREATE OR REPLACE FUNCTION list_spaces()
RETURNS TABLE (
  id uuid,
  name text,
  agent_id uuid,
  agent_name text,
  agent_model text,
  agent_last_heartbeat_at timestamptz,
  role text,
  member_count bigint,
  created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    s.id,
    s.name,
    s.agent_id,
    a.name AS agent_name,
    a.model AS agent_model,
    a.last_heartbeat_at AS agent_last_heartbeat_at,
    sm.role,
    (SELECT count(*) FROM space_members sm2 WHERE sm2.space_id = s.id) AS member_count,
    s.created_at
  FROM spaces s
  JOIN space_members sm ON sm.space_id = s.id AND sm.profile_id = auth.uid()
  JOIN agents a ON a.id = s.agent_id
  ORDER BY s.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION create_channel(p_space_id uuid, p_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  new_id uuid;
BEGIN
  -- Verify caller is a member of the space
  IF NOT EXISTS (
    SELECT 1 FROM space_members
    WHERE space_id = p_space_id AND profile_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this space';
  END IF;

  INSERT INTO channels (name, space_id)
  VALUES (COALESCE(p_name, 'new_channel'), p_space_id)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;
