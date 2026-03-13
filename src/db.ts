import type { SupabaseClient } from "@supabase/supabase-js";

export interface HumanMessage {
  id: string;
  text: string;
  channelId: string;
  threadId: string | null;
}

export async function createMessage(
  supabase: SupabaseClient,
  channelId: string,
  role: "human" | "agent",
  threadId?: string | null
): Promise<string> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel_id: channelId,
      role,
      ...(threadId && { thread_id: threadId }),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function persistEvent(
  supabase: SupabaseClient,
  messageId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from("events")
    .insert({ message_id: messageId, type, payload });
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

export async function getThreadSessionId(
  supabase: SupabaseClient,
  threadId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("session_id")
    .eq("thread_id", threadId)
    .eq("role", "agent")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return data.session_id ?? null;
}

export async function createThread(
  supabase: SupabaseClient,
  channelId: string,
  rootMessageId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("threads")
    .insert({ channel_id: channelId, root_message_id: rootMessageId })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateThreadActivity(
  supabase: SupabaseClient,
  threadId: string
): Promise<void> {
  const { error } = await supabase
    .from("threads")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", threadId);
  if (error) throw error;
}

export async function updateMessageSessionId(
  supabase: SupabaseClient,
  messageId: string,
  sessionId: string
): Promise<void> {
  const { error } = await supabase
    .from("messages")
    .update({ session_id: sessionId })
    .eq("id", messageId);
  if (error) throw error;
}

export async function getChannelSummary(
  supabase: SupabaseClient,
  channelId: string,
  limit = 20
): Promise<string | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, events(payload)")
    .eq("channel_id", channelId)
    .is("thread_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data?.length) return null;

  const lines: string[] = [];
  for (const msg of data.reverse()) {
    const events = msg.events as Array<{ payload: { text?: string } }>;
    const text = events?.[0]?.payload?.text;
    if (text) {
      lines.push(`${msg.role}: ${text}`);
    }
  }

  return lines.length ? lines.join("\n") : null;
}
