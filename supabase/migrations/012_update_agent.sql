-- Update agent details (currently just name).
-- Ownership enforced server-side: only the agent's owner can update.

CREATE FUNCTION update_agent(p_agent_id uuid, p_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_owner_id uuid;
BEGIN
  -- Verify caller owns the agent
  SELECT owner_id INTO v_owner_id
  FROM public.agents
  WHERE id = p_agent_id;

  IF v_owner_id IS NULL OR v_owner_id != auth.uid() THEN
    RAISE EXCEPTION 'Not the agent owner';
  END IF;

  UPDATE public.agents
  SET name = p_name, updated_at = now()
  WHERE id = p_agent_id;
END;
$$;
