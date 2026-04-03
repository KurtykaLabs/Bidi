-- Drop space name: use agent name as the sole display name.
-- Spaces no longer have their own name — the agent's name is the identity.

-- 1. Drop functions that reference spaces.name before dropping the column
--    (list_spaces is LANGUAGE sql, so Postgres tracks column dependencies)
DROP FUNCTION IF EXISTS list_spaces();
DROP FUNCTION IF EXISTS create_space(uuid, text);

-- 2. Drop spaces.name entirely — agent name is the sole identity
ALTER TABLE public.spaces DROP COLUMN name;

-- 3. Recreate list_spaces — name now comes from agents

CREATE FUNCTION list_spaces()
RETURNS TABLE (
  id uuid,
  name text,
  agent_id uuid,
  agent_model text,
  agent_last_heartbeat_at timestamptz,
  role text,
  member_count bigint,
  created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    s.id,
    a.name,
    s.agent_id,
    a.model AS agent_model,
    a.last_heartbeat_at AS agent_last_heartbeat_at,
    sm.role,
    COUNT(sm2.profile_id) AS member_count,
    s.created_at
  FROM spaces s
  JOIN space_members sm ON sm.space_id = s.id AND sm.profile_id = auth.uid()
  JOIN agents a ON a.id = s.agent_id
  LEFT JOIN space_members sm2 ON sm2.space_id = s.id
  GROUP BY s.id, a.name, s.agent_id, a.model, a.last_heartbeat_at, sm.role, s.created_at
  ORDER BY s.created_at DESC;
$$;

-- 4. Recreate create_space without name parameter

CREATE FUNCTION create_space(p_agent_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_space_id uuid;
  v_owner_id uuid;
BEGIN
  SELECT owner_id INTO v_owner_id
  FROM public.agents
  WHERE id = p_agent_id;

  IF v_owner_id IS NULL OR v_owner_id != auth.uid() THEN
    RAISE EXCEPTION 'Not the agent owner';
  END IF;

  INSERT INTO public.spaces (agent_id)
  VALUES (p_agent_id)
  RETURNING id INTO v_space_id;

  INSERT INTO public.space_members (space_id, profile_id, role)
  VALUES (v_space_id, auth.uid(), 'owner');

  INSERT INTO public.channels (name, space_id)
  VALUES ('general', v_space_id);

  RETURN v_space_id;
END;
$$;
