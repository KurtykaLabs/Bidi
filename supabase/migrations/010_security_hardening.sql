-- Security hardening: fix Supabase linter alerts + defense-in-depth
--
-- 1. Drop stale public-role policies on profiles
-- 2. Pin search_path on handle_new_user, handle_updated_at, send_message
-- 3. Revoke anon privileges on all tables and functions

-- 1. Drop stale public-role policies on profiles
-- These were created via the dashboard and never removed when migration 009
-- added correct authenticated-only replacements.
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- 2. Fix search_path on three functions flagged by Supabase linter

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $function$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.send_message(p_channel_id uuid, p_text text, p_parent_message_id uuid DEFAULT NULL::uuid)
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
  values (v_message_id, 'text', jsonb_build_object('text', p_text));

  return v_message_id;
end;
$function$;

-- 3. Revoke anon privileges on all public tables, functions, and sequences.
-- This app requires authentication — anon should have no access.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Revoke from PUBLIC (the implicit PostgreSQL grant that anon inherits),
-- then re-grant to authenticated and service_role.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
