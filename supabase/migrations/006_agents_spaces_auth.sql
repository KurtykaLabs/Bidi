-- Agents, Spaces, and Auth Integration
-- Adds ownership model: profiles own agents, agents own spaces,
-- spaces contain channels, messages track senders.

-- 1. Agents table (owned by a profile, parallel to profiles)
CREATE TABLE public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  model text,
  last_heartbeat_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_agents_owner ON public.agents(owner_id);

-- 2. Spaces table (one agent per space, for now)
CREATE TABLE public.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_spaces_agent ON public.spaces(agent_id);

-- 3. Space members (join table: who has access)
CREATE TABLE public.space_members (
  space_id uuid NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (space_id, profile_id)
);

CREATE INDEX idx_space_members_profile ON public.space_members(profile_id);

-- 4. Add space_id to channels (nullable for legacy rows)
ALTER TABLE public.channels ADD COLUMN space_id uuid REFERENCES public.spaces(id);
CREATE INDEX idx_channels_space ON public.channels(space_id);

-- 5. Add sender columns to messages
ALTER TABLE public.messages ADD COLUMN profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.messages ADD COLUMN agent_id uuid REFERENCES public.agents(id);

-- 6. Enable Realtime on new tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.agents;
ALTER PUBLICATION supabase_realtime ADD TABLE public.spaces;
ALTER PUBLICATION supabase_realtime ADD TABLE public.space_members;

-- 7. SECURITY DEFINER function: create_space
-- Solves chicken-and-egg: owner can't insert into space_members
-- before the space exists, and RLS on space_members requires membership.
CREATE OR REPLACE FUNCTION create_space(p_agent_id uuid, p_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_space_id uuid;
  v_owner_id uuid;
BEGIN
  -- Verify caller owns the agent
  SELECT owner_id INTO v_owner_id
  FROM public.agents
  WHERE id = p_agent_id;

  IF v_owner_id IS NULL OR v_owner_id != auth.uid() THEN
    RAISE EXCEPTION 'Not the agent owner';
  END IF;

  -- Create the space
  INSERT INTO public.spaces (agent_id, name)
  VALUES (p_agent_id, p_name)
  RETURNING id INTO v_space_id;

  -- Add caller as owner
  INSERT INTO public.space_members (space_id, profile_id, role)
  VALUES (v_space_id, auth.uid(), 'owner');

  -- Create default channel
  INSERT INTO public.channels (name, space_id)
  VALUES ('general', v_space_id);

  RETURN v_space_id;
END;
$$;

-- 8. Update list_channels to scope by space
CREATE OR REPLACE FUNCTION list_channels(p_space_id uuid DEFAULT NULL)
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
  WHERE (p_space_id IS NULL AND c.space_id IS NULL)
     OR c.space_id = p_space_id
  ORDER BY last_activity_at DESC;
$$;

-- 9. RLS Policies

-- Profiles (RLS already enabled on this table)
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated USING (id = auth.uid());

-- Agents
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_select ON public.agents
  FOR SELECT TO authenticated USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.spaces s
      JOIN public.space_members sm ON sm.space_id = s.id
      WHERE s.agent_id = agents.id AND sm.profile_id = auth.uid()
    )
  );
CREATE POLICY agents_insert ON public.agents
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY agents_update ON public.agents
  FOR UPDATE TO authenticated USING (owner_id = auth.uid());
CREATE POLICY agents_delete ON public.agents
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- Spaces
ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY spaces_select ON public.spaces
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = spaces.id AND sm.profile_id = auth.uid()
    )
  );
CREATE POLICY spaces_update ON public.spaces
  FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = spaces.id AND sm.profile_id = auth.uid() AND sm.role = 'owner'
    )
  );
CREATE POLICY spaces_delete ON public.spaces
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = spaces.id AND sm.profile_id = auth.uid() AND sm.role = 'owner'
    )
  );

-- Space Members
ALTER TABLE public.space_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY space_members_select ON public.space_members
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.space_members sm2
      WHERE sm2.space_id = space_members.space_id AND sm2.profile_id = auth.uid()
    )
  );
CREATE POLICY space_members_insert ON public.space_members
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = space_members.space_id AND sm.profile_id = auth.uid() AND sm.role = 'owner'
    )
  );
CREATE POLICY space_members_delete ON public.space_members
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = space_members.space_id AND sm.profile_id = auth.uid() AND sm.role = 'owner'
    )
  );

-- Channels
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY channels_select ON public.channels
  FOR SELECT TO authenticated USING (
    space_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = channels.space_id AND sm.profile_id = auth.uid()
    )
  );
CREATE POLICY channels_insert ON public.channels
  FOR INSERT TO authenticated WITH CHECK (
    space_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = channels.space_id AND sm.profile_id = auth.uid()
    )
  );
CREATE POLICY channels_update ON public.channels
  FOR UPDATE TO authenticated USING (
    space_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.space_members sm
      WHERE sm.space_id = channels.space_id AND sm.profile_id = auth.uid()
    )
  );

-- Messages
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_select ON public.messages
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.channels c
      JOIN public.space_members sm ON sm.space_id = c.space_id
      WHERE c.id = messages.channel_id AND sm.profile_id = auth.uid()
    )
  );
CREATE POLICY messages_insert ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.channels c
      JOIN public.space_members sm ON sm.space_id = c.space_id
      WHERE c.id = messages.channel_id AND sm.profile_id = auth.uid()
    )
  );

-- Events
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

CREATE POLICY events_select ON public.events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      JOIN public.space_members sm ON sm.space_id = c.space_id
      WHERE m.id = events.message_id AND sm.profile_id = auth.uid()
    )
  );
CREATE POLICY events_insert ON public.events
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      JOIN public.space_members sm ON sm.space_id = c.space_id
      WHERE m.id = events.message_id AND sm.profile_id = auth.uid()
    )
  );
