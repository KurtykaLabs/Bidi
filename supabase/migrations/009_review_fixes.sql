-- PR review fixes:
-- 1. SET search_path on all SECURITY DEFINER functions
-- 2. Restrict profiles_select to own row
-- 3. Delete legacy channels (space_id NULL), make space_id NOT NULL
-- 4. Drop old create_channel(text) overload
-- 5. Remove space_id IS NULL fallbacks from RLS policies
-- 6. Rewrite list_spaces with GROUP BY instead of correlated subquery

-- 1. Fix search_path on all SECURITY DEFINER functions

CREATE OR REPLACE FUNCTION is_space_member(p_space_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.space_members
    WHERE space_id = p_space_id AND profile_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION is_space_owner(p_space_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.space_members
    WHERE space_id = p_space_id AND profile_id = auth.uid() AND role = 'owner'
  );
$$;

CREATE OR REPLACE FUNCTION create_space(p_agent_id uuid, p_name text)
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

  INSERT INTO public.spaces (agent_id, name)
  VALUES (p_agent_id, p_name)
  RETURNING id INTO v_space_id;

  INSERT INTO public.space_members (space_id, profile_id, role)
  VALUES (v_space_id, auth.uid(), 'owner');

  INSERT INTO public.channels (name, space_id)
  VALUES ('general', v_space_id);

  RETURN v_space_id;
END;
$$;

-- Drop old create_channel(text) — replaced by space-aware version
DROP FUNCTION IF EXISTS create_channel(text);

-- Recreate create_channel with search_path
CREATE OR REPLACE FUNCTION create_channel(p_space_id uuid, p_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  new_id uuid;
BEGIN
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

-- Rewrite list_spaces with GROUP BY and search_path
DROP FUNCTION list_spaces();

CREATE FUNCTION list_spaces()
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
) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    s.id,
    s.name,
    s.agent_id,
    a.name AS agent_name,
    a.model AS agent_model,
    a.last_heartbeat_at AS agent_last_heartbeat_at,
    sm.role,
    COUNT(sm2.profile_id) AS member_count,
    s.created_at
  FROM spaces s
  JOIN space_members sm ON sm.space_id = s.id AND sm.profile_id = auth.uid()
  JOIN agents a ON a.id = s.agent_id
  LEFT JOIN space_members sm2 ON sm2.space_id = s.id
  GROUP BY s.id, s.name, s.agent_id, a.name, a.model, a.last_heartbeat_at, sm.role, s.created_at
  ORDER BY s.created_at DESC;
$$;

-- Drop old list_channels overloads and recreate space-scoped only
DROP FUNCTION IF EXISTS list_channels(uuid);
DROP FUNCTION IF EXISTS list_channels();

CREATE FUNCTION list_channels(p_space_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  last_activity_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    c.id,
    c.name,
    c.created_at,
    COALESCE(
      (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id),
      c.created_at
    ) AS last_activity_at
  FROM channels c
  WHERE c.space_id = p_space_id
  ORDER BY last_activity_at DESC;
$$;

-- 2. Fix profiles_select — restrict to own row
DROP POLICY profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

-- 3. Delete legacy data and make space_id NOT NULL
DELETE FROM events WHERE message_id IN (
  SELECT m.id FROM messages m
  JOIN channels c ON c.id = m.channel_id
  WHERE c.space_id IS NULL
);
DELETE FROM messages WHERE channel_id IN (
  SELECT id FROM channels WHERE space_id IS NULL
);
DELETE FROM channels WHERE space_id IS NULL;

ALTER TABLE public.channels ALTER COLUMN space_id SET NOT NULL;

-- 5. Remove space_id IS NULL fallbacks from RLS policies

DROP POLICY channels_select ON public.channels;
CREATE POLICY channels_select ON public.channels
  FOR SELECT TO authenticated USING (is_space_member(space_id));

DROP POLICY channels_insert ON public.channels;
CREATE POLICY channels_insert ON public.channels
  FOR INSERT TO authenticated WITH CHECK (is_space_member(space_id));

DROP POLICY channels_update ON public.channels;
CREATE POLICY channels_update ON public.channels
  FOR UPDATE TO authenticated USING (is_space_member(space_id));

DROP POLICY messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.channels c
      WHERE c.id = messages.channel_id AND is_space_member(c.space_id)
    )
  );

DROP POLICY messages_insert ON public.messages;
CREATE POLICY messages_insert ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.channels c
      WHERE c.id = messages.channel_id AND is_space_member(c.space_id)
    )
  );

DROP POLICY events_select ON public.events;
CREATE POLICY events_select ON public.events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      WHERE m.id = events.message_id AND is_space_member(c.space_id)
    )
  );

DROP POLICY events_insert ON public.events;
CREATE POLICY events_insert ON public.events
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      WHERE m.id = events.message_id AND is_space_member(c.space_id)
    )
  );
