import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { AgentEvent } from "./agent.js";

const MILESTONE_TYPES = new Set([
  "assistant_message",
  "tool_use_start",
  "tool_result",
  "result",
]);

export class Chat {
  private supabase: SupabaseClient;
  private channel: RealtimeChannel;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY = 60_000;
  private static readonly BASE_RECONNECT_DELAY = 3_000;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.channel = this.supabase.channel("chat");
  }

  subscribe(onMessage: (text: string) => void): void {
    this.disposed = false;
    this.channel
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "human_events" },
        (payload) => {
          const payloadData = payload.new.payload as { text?: string };
          const text = payloadData?.text ?? "";
          onMessage(text);
        }
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          this.reconnectAttempts = 0;
          console.log("Realtime channel connected");
        } else if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
          console.error(`Realtime channel ${status}`, err);
          if (!this.disposed) this.reconnect(onMessage);
        }
      });
  }

  private reconnect(onMessage: (text: string) => void): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      Chat.BASE_RECONNECT_DELAY * 2 ** this.reconnectAttempts,
      Chat.MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`Attempting to reconnect (attempt ${this.reconnectAttempts})...`);
      this.channel.unsubscribe();
      this.channel = this.supabase.channel("chat");
      this.subscribe(onMessage);
    }, delay);
  }

  broadcastAgentEvent(event: AgentEvent, sender: string): void {
    this.channel.send({
      type: "broadcast",
      event: "agent_event",
      payload: { ...event, sender },
    });
  }

  async persistAgentEvent(event: AgentEvent): Promise<void> {
    if (!MILESTONE_TYPES.has(event.type)) return;

    const { type, ...payload } = event;
    const { error } = await this.supabase
      .from("agent_events")
      .insert({ type, payload });
    if (error) throw error;
  }

  unsubscribe(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.channel.unsubscribe();
  }
}
