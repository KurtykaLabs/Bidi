-- Whitepaper contract cutover:
-- 1. Move wrapped seed material off public.profiles into owner-only
--    public.encryption_keys.
-- 2. Replace send_message so callers pass the fully encrypted JSON payload as
--    a raw base64 string, stored as a JSONB string in events.payload.
-- 3. Drop the old profile blob columns. This migration assumes a pre-launch
--    reset and intentionally does not preserve prior dev data.

CREATE TABLE IF NOT EXISTS public.encryption_keys (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  passphrase_blob text NOT NULL,
  recovery_blob text
);

ALTER TABLE public.encryption_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS encryption_keys_select ON public.encryption_keys;
DROP POLICY IF EXISTS encryption_keys_insert ON public.encryption_keys;
DROP POLICY IF EXISTS encryption_keys_update ON public.encryption_keys;
DROP POLICY IF EXISTS encryption_keys_delete ON public.encryption_keys;

CREATE POLICY encryption_keys_select ON public.encryption_keys
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

CREATE POLICY encryption_keys_insert ON public.encryption_keys
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

CREATE POLICY encryption_keys_update ON public.encryption_keys
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

CREATE POLICY encryption_keys_delete ON public.encryption_keys
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS wrapped_seed,
  DROP COLUMN IF EXISTS wrapped_seed_recovery,
  DROP COLUMN IF EXISTS key_version;

CREATE OR REPLACE FUNCTION public.send_message(
  p_channel_id uuid,
  p_payload text,
  p_parent_message_id uuid DEFAULT NULL::uuid
)
RETURNS uuid LANGUAGE plpgsql
SET search_path = public
AS $function$
declare
  v_message_id uuid;
begin
  insert into messages (channel_id, role, parent_message_id)
  values (p_channel_id, 'human', p_parent_message_id)
  returning id into v_message_id;

  insert into events (message_id, type, payload)
  values (v_message_id, 'text', to_jsonb(p_payload));

  return v_message_id;
end;
$function$;
