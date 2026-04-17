-- E2E encryption per bidi.sh/whitepaper.
-- Adds per-profile key material (wrapped seed + pubkey) and per-member wrapped
-- space keys. Replaces create_space so the owner's sealed space key is inserted
-- atomically alongside the space_members row.

-- 1. Profile-level key material
ALTER TABLE public.profiles
  ADD COLUMN public_key text,
  ADD COLUMN wrapped_seed text,
  ADD COLUMN wrapped_seed_recovery text,
  ADD COLUMN key_version smallint NOT NULL DEFAULT 1;

-- 2. Per-member sealed space key
ALTER TABLE public.space_members
  ADD COLUMN wrapped_key text;

-- 3. Drop the channel name format constraint — encrypted names use enc:<base64url>
--    and will never match ^[a-z0-9_]+$ (from migration 005). Replace with a loose
--    length bound so empty/oversized names still get rejected.
ALTER TABLE public.channels
  DROP CONSTRAINT IF EXISTS channel_name_format;

ALTER TABLE public.channels
  ADD CONSTRAINT channel_name_length CHECK (length(name) BETWEEN 1 AND 200);

-- 4. Replace create_space so the caller's wrapped_key is inserted in the same
--    transaction as the space_members row. Otherwise there's a window where a
--    member row exists without a decryptable space key.
DROP FUNCTION IF EXISTS public.create_space(uuid);

CREATE FUNCTION public.create_space(
  p_agent_id uuid,
  p_wrapped_key text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_space_id uuid;
  v_owner_id uuid;
BEGIN
  SELECT owner_id INTO v_owner_id FROM public.agents WHERE id = p_agent_id;
  IF v_owner_id IS NULL OR v_owner_id != auth.uid() THEN
    RAISE EXCEPTION 'Not the agent owner';
  END IF;
  -- Sealed-box base64 of a 32-byte space key is ~108 chars; reject anything
  -- materially shorter as malformed input.
  IF p_wrapped_key IS NULL OR length(p_wrapped_key) < 100 THEN
    RAISE EXCEPTION 'wrapped_key required';
  END IF;

  INSERT INTO public.spaces (agent_id)
  VALUES (p_agent_id)
  RETURNING id INTO v_space_id;

  INSERT INTO public.space_members (space_id, profile_id, role, wrapped_key)
  VALUES (v_space_id, auth.uid(), 'owner', p_wrapped_key);

  INSERT INTO public.channels (name, space_id)
  VALUES ('new_channel', v_space_id);

  RETURN v_space_id;
END;
$$;
