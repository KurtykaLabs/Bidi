import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { AgentEvent } from "./agent.js";
import { getHumanMessagesSince } from "./db.js";

export interface MessageRow {
  id: string;
  role: string;
  channel_id: string;
  parent_message_id: string | null;
  created_at: string;
}

export class RealtimeListener {
  private supabase: SupabaseClient;
  private listenerChannel: RealtimeChannel;
  private broadcastChannels = new Map<string, RealtimeChannel>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private reconnectAttempts = 0;
  private lastSeenAt: string = new Date().toISOString();
  private static readonly MAX_RECONNECT_DELAY = 60_000;
  private static readonly BASE_RECONNECT_DELAY = 3_000;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.listenerChannel = this.supabase.channel("messages:all");
  }

  subscribe(onMessage: (row: MessageRow) => void | Promise<void>): void {
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
          if (row.created_at) this.lastSeenAt = row.created_at;
          Promise.resolve(onMessage(row)).catch((err) => {
            console.error(`[realtime] onMessage error: ${err.message}`);
          });
        }
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          const isReconnect = this.reconnectAttempts > 0;
          this.reconnectAttempts = 0;
          console.log("Realtime listener connected");
          if (isReconnect) {
            this.catchUpMissedMessages(onMessage);
          }
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
    this.listenerChannel = this.supabase.channel("messages:all");
    for (const channel of this.broadcastChannels.values()) {
      this.supabase.removeChannel(channel);
    }
    this.broadcastChannels.clear();
  }

  private async catchUpMissedMessages(onMessage: (row: MessageRow) => void | Promise<void>): Promise<void> {
    try {
      const missed = await getHumanMessagesSince(this.supabase, this.lastSeenAt);
      if (missed.length > 0) {
        console.log(`[realtime] catching up on ${missed.length} missed message(s)`);
        for (const row of missed) {
          await Promise.resolve(onMessage(row)).catch((err) => {
            console.error(`[realtime] catch-up onMessage error: ${err.message}`);
          });
        }
        const last = missed[missed.length - 1];
        if (last.created_at) this.lastSeenAt = last.created_at;
      }
    } catch (err: any) {
      console.error(`[realtime] catch-up query failed: ${err.message}`);
    }
  }

  private reconnect(onMessage: (row: MessageRow) => void | Promise<void>): void {
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
