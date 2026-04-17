import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decryptJsonPayload,
  encryptJsonPayload,
  isEncryptedPayload,
} from "./crypto.js";
import type { Keyring } from "./keyring.js";

export interface HumanMessage {
  id: string;
  text: string;
  channelId: string;
  parentMessageId: string | null;
}

export interface ProfileKeys {
  id: string;
  public_key: string | null;
  passphrase_blob: string | null;
  recovery_blob: string | null;
}

export async function createMessage(
  supabase: SupabaseClient,
  channelId: string,
  role: "human" | "agent",
  parentMessageId?: string | null,
  senderId?: { profileId?: string; agentId?: string }
): Promise<string> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      role,
      ...(parentMessageId && { parent_message_id: parentMessageId }),
      ...(senderId?.profileId && { profile_id: senderId.profileId }),
      ...(senderId?.agentId && { agent_id: senderId.agentId }),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function persistEvent(
  supabase: SupabaseClient,
  eventId: string,
  messageId: string,
  type: string,
  payload: Record<string, unknown>,
  keyring: Keyring
): Promise<void> {
  const encoded = await encryptJsonPayload(keyring.getSpaceKey(), payload);
  const { error } = await supabase
    .from("events")
    .insert({ id: eventId, message_id: messageId, type, payload: encoded });
  if (error) throw error;
}

// Encrypted payloads are JSONB strings (base64 of the unified content blob);
// legacy plaintext payloads are JSONB objects. This invariant holds because
// no writer in this codebase has ever stored a string-typed JSONB payload as
// plaintext — `persistEvent` always passed a `Record<string, unknown>`. Writers
// from other clients (e.g. mobile via `send_message` RPC) follow the same
// rule. If that ever changes, this discriminator must be revisited (likely by
// adding a structural marker, e.g. a leading byte check).
async function decryptPayload(
  keyring: Keyring,
  payload: unknown
): Promise<Record<string, unknown>> {
  if (isEncryptedPayload(payload)) {
    return decryptJsonPayload(keyring.getSpaceKey(), payload);
  }
  return (payload as Record<string, unknown>) ?? {};
}

export async function getMessageText(
  supabase: SupabaseClient,
  messageId: string,
  keyring: Keyring
): Promise<string | null> {
  const { data, error } = await supabase
    .from("events")
    .select("payload")
    .eq("message_id", messageId)
    .eq("type", "text")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (error) return null;
  const decoded = await decryptPayload(keyring, data.payload);
  return (decoded as { text?: string })?.text ?? null;
}

export async function getChannelSessionId(
  supabase: SupabaseClient,
  channelId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("channels")
    .select("session_id")
    .eq("id", channelId)
    .single();
  if (error) return null;
  return data.session_id ?? null;
}

export async function updateChannelName(
  supabase: SupabaseClient,
  channelId: string,
  name: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("channels")
    .update({ name })
    .eq("id", channelId)
    .eq("name", "new_channel")
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function updateChannelSessionId(
  supabase: SupabaseClient,
  channelId: string,
  sessionId: string
): Promise<void> {
  const { error } = await supabase
    .from("channels")
    .update({ session_id: sessionId })
    .eq("id", channelId);
  if (error) throw error;
}

export async function getHumanMessagesSince(
  supabase: SupabaseClient,
  since: string
): Promise<Array<{ id: string; role: string; channel_id: string; parent_message_id: string | null; created_at: string }>> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, channel_id, parent_message_id, created_at")
    .eq("role", "human")
    .gt("created_at", since)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function updateAgentModel(
  supabase: SupabaseClient,
  agentId: string,
  model: string
): Promise<void> {
  const { error } = await supabase
    .from("agents")
    .update({ model })
    .eq("id", agentId);
  if (error) console.error(`[model] ${error.message}`);
}

export async function updateAgentHeartbeat(
  supabase: SupabaseClient,
  agentId: string
): Promise<void> {
  const { error } = await supabase
    .from("agents")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("id", agentId);
  if (error) console.error(`[heartbeat] ${error.message}`);
}

export async function getChannelSummary(
  supabase: SupabaseClient,
  channelId: string,
  keyring: Keyring,
  limit = 20
): Promise<string | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, events!inner(type, payload)")
    .eq("channel_id", channelId)
    .is("parent_message_id", null)
    .in("events.type", ["text", "assistant_message"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data?.length) return null;

  const lines: string[] = [];
  for (const msg of data.reverse()) {
    const events = msg.events as Array<{ type: string; payload: unknown }>;
    const textEvent = events?.find(
      (e) => e.type === "text" || e.type === "assistant_message"
    );
    if (!textEvent) continue;
    const decoded = await decryptPayload(keyring, textEvent.payload);
    const text = (decoded as { text?: string }).text;
    if (text) lines.push(`${msg.role}: ${text}`);
  }

  return lines.length ? lines.join("\n") : null;
}

export async function fetchProfileKeys(
  supabase: SupabaseClient,
  profileId: string
): Promise<ProfileKeys> {
  const [profileResult, encryptionResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, public_key")
      .eq("id", profileId)
      .single(),
    supabase
      .from("encryption_keys")
      .select("passphrase_blob, recovery_blob")
      .eq("profile_id", profileId)
      .maybeSingle(),
  ]);

  if (profileResult.error) {
    throw new Error(`Failed to fetch profile keys: ${profileResult.error.message}`);
  }
  if (encryptionResult.error) {
    throw new Error(`Failed to fetch encryption keys: ${encryptionResult.error.message}`);
  }

  return {
    id: profileResult.data.id,
    public_key: profileResult.data.public_key,
    passphrase_blob: encryptionResult.data?.passphrase_blob ?? null,
    recovery_blob: encryptionResult.data?.recovery_blob ?? null,
  };
}

export async function createProfileKeys(
  supabase: SupabaseClient,
  profileId: string,
  fields: Omit<ProfileKeys, "id">
): Promise<void> {
  const { data, error } = await supabase
    .from("profiles")
    .update({ public_key: fields.public_key })
    .eq("id", profileId)
    .is("public_key", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Failed to update profile keys: ${error.message}`);
  if (!data) {
    // Keep the DB helper's failure mode explicit for callers that pre-check
    // and treat "already exists" as a control-flow branch.
    throw new Error("Failed to update profile keys: identity_already_exists");
  }

  const { error: encryptionError } = await supabase
    .from("encryption_keys")
    .insert({
      profile_id: profileId,
      passphrase_blob: fields.passphrase_blob,
      recovery_blob: fields.recovery_blob,
    });
  if (encryptionError) {
    throw new Error(`Failed to create encryption keys: ${encryptionError.message}`);
  }
}

export async function updatePassphraseBlob(
  supabase: SupabaseClient,
  profileId: string,
  passphraseBlob: string
): Promise<void> {
  const { error } = await supabase
    .from("encryption_keys")
    .update({ passphrase_blob: passphraseBlob })
    .eq("profile_id", profileId);
  if (error) {
    throw new Error(`Failed to update encryption keys: ${error.message}`);
  }
}

export async function fetchWrappedKey(
  supabase: SupabaseClient,
  spaceId: string,
  profileId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("space_members")
    .select("wrapped_key")
    .eq("space_id", spaceId)
    .eq("profile_id", profileId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch wrapped_key: ${error.message}`);
  return data?.wrapped_key ?? null;
}

export async function updateWrappedKey(
  supabase: SupabaseClient,
  spaceId: string,
  profileId: string,
  wrappedKey: string
): Promise<void> {
  const { error } = await supabase
    .from("space_members")
    .update({ wrapped_key: wrappedKey })
    .eq("space_id", spaceId)
    .eq("profile_id", profileId);
  if (error) throw new Error(`Failed to update wrapped_key: ${error.message}`);
}
