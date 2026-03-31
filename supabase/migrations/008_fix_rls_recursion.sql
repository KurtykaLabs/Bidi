-- Fix infinite recursion in RLS policies.
-- space_members SELECT policy referenced itself, causing recursion
-- when any policy checked membership via inline EXISTS subquery.
-- Solution: SECURITY DEFINER helper functions that bypass RLS.

CREATE OR REPLACE FUNCTION is_space_member(p_space_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.space_members
    WHERE space_id = p_space_id AND profile_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION is_space_owner(p_space_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.space_members
    WHERE space_id = p_space_id AND profile_id = auth.uid() AND role = 'owner'
  );
$$;

-- Recreate all policies using the helper functions

DROP POLICY space_members_select ON public.space_members;
CREATE POLICY space_members_select ON public.space_members
  FOR SELECT TO authenticated USING (is_space_member(space_id));

DROP POLICY space_members_insert ON public.space_members;
CREATE POLICY space_members_insert ON public.space_members
  FOR INSERT TO authenticated WITH CHECK (is_space_owner(space_id));

DROP POLICY space_members_delete ON public.space_members;
CREATE POLICY space_members_delete ON public.space_members
  FOR DELETE TO authenticated USING (is_space_owner(space_id));

DROP POLICY agents_select ON public.agents;
CREATE POLICY agents_select ON public.agents
  FOR SELECT TO authenticated USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.spaces s
      WHERE s.agent_id = agents.id AND is_space_member(s.id)
    )
  );

DROP POLICY spaces_select ON public.spaces;
CREATE POLICY spaces_select ON public.spaces
  FOR SELECT TO authenticated USING (is_space_member(id));

DROP POLICY spaces_update ON public.spaces;
CREATE POLICY spaces_update ON public.spaces
  FOR UPDATE TO authenticated USING (is_space_owner(id));

DROP POLICY spaces_delete ON public.spaces;
CREATE POLICY spaces_delete ON public.spaces
  FOR DELETE TO authenticated USING (is_space_owner(id));

DROP POLICY channels_select ON public.channels;
CREATE POLICY channels_select ON public.channels
  FOR SELECT TO authenticated USING (
    space_id IS NULL OR is_space_member(space_id)
  );

DROP POLICY channels_insert ON public.channels;
CREATE POLICY channels_insert ON public.channels
  FOR INSERT TO authenticated WITH CHECK (
    space_id IS NULL OR is_space_member(space_id)
  );

DROP POLICY channels_update ON public.channels;
CREATE POLICY channels_update ON public.channels
  FOR UPDATE TO authenticated USING (
    space_id IS NULL OR is_space_member(space_id)
  );

DROP POLICY messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.channels c
      WHERE c.id = messages.channel_id AND (c.space_id IS NULL OR is_space_member(c.space_id))
    )
  );

DROP POLICY messages_insert ON public.messages;
CREATE POLICY messages_insert ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.channels c
      WHERE c.id = messages.channel_id AND (c.space_id IS NULL OR is_space_member(c.space_id))
    )
  );

DROP POLICY events_select ON public.events;
CREATE POLICY events_select ON public.events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      WHERE m.id = events.message_id AND (c.space_id IS NULL OR is_space_member(c.space_id))
    )
  );

DROP POLICY events_insert ON public.events;
CREATE POLICY events_insert ON public.events
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      WHERE m.id = events.message_id AND (c.space_id IS NULL OR is_space_member(c.space_id))
    )
  );
