import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { AgentEvent } from "./agent.js";

export interface MessageRow {
  id: string;
  role: string;
  channel_id: string;
  thread_id: string | null;
}

export class RealtimeListener {
  private supabase: SupabaseClient;
  private listenerChannel: RealtimeChannel;
  private broadcastChannels = new Map<string, RealtimeChannel>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY = 60_000;
  private static readonly BASE_RECONNECT_DELAY = 3_000;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.listenerChannel = this.supabase.channel("messages:all");
  }

  subscribe(onMessage: (row: MessageRow) => void): void {
    this.disposed = false;
    this.listenerChannel
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          const row = payload.new as MessageRow;
          if (row.role !== "human") return;
          onMessage(row);
        }
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          this.reconnectAttempts = 0;
          console.log("Realtime listener connected");
        } else if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
          console.error(`Realtime listener ${status}`, err);
          if (!this.disposed) this.reconnect(onMessage);
        }
      });
  }

  broadcastAgentEvent(channelId: string, event: AgentEvent, messageId: string): void {
    let channel = this.broadcastChannels.get(channelId);
    if (!channel) {
      channel = this.supabase.channel(`channel:${channelId}`);
      channel.subscribe();
      this.broadcastChannels.set(channelId, channel);
    }
    channel.send({
      type: "broadcast",
      event: "agent_event",
      payload: { ...event, message_id: messageId },
    });
  }

  unsubscribe(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.supabase.removeChannel(this.listenerChannel);
    for (const channel of this.broadcastChannels.values()) {
      this.supabase.removeChannel(channel);
    }
    this.broadcastChannels.clear();
  }

  private reconnect(onMessage: (row: MessageRow) => void): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RealtimeListener.BASE_RECONNECT_DELAY * 2 ** this.reconnectAttempts,
      RealtimeListener.MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`Attempting to reconnect (attempt ${this.reconnectAttempts})...`);
      this.supabase.removeChannel(this.listenerChannel);
      this.listenerChannel = this.supabase.channel("messages:all");
      this.subscribe(onMessage);
    }, delay);
  }
}
