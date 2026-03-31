import type { SupabaseClient } from "@supabase/supabase-js";

export interface HumanMessage {
  id: string;
  text: string;
  channelId: string;
  parentMessageId: string | null;
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
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from("events")
    .insert({ id: eventId, message_id: messageId, type, payload });
  if (error) throw error;
}

export async function getMessageText(
  supabase: SupabaseClient,
  messageId: string
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
  return (data.payload as { text?: string })?.text ?? null;
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
    const events = msg.events as Array<{ type: string; payload: { text?: string } }>;
    const textEvent = events?.find(
      (e) => e.type === "text" || e.type === "assistant_message"
    );
    const text = textEvent?.payload?.text;
    if (text) {
      lines.push(`${msg.role}: ${text}`);
    }
  }

  return lines.length ? lines.join("\n") : null;
}
