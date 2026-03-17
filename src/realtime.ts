import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { AgentEvent } from "./agent.js";
import { getHumanMessagesSince } from "./db.js";
import { appendFileSync } from "node:fs";

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
  private broadcastReady = new Map<string, Promise<void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private reconnectAttempts = 0;
  private lastSeenAt: string = new Date().toISOString();
  private connectedAt: number | null = null;
  private disconnectedAt: number | null = null;
  private static readonly MAX_RECONNECT_DELAY = 60_000;
  private static readonly BASE_RECONNECT_DELAY = 3_000;
  private static readonly STABLE_CONNECTION_MS = 30_000;

  private static readonly LOG_FILE = "bidi.log";

  private ts(): string {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  private log(msg: string): void {
    const line = `[${this.ts()}] ${msg}`;
    console.log(line);
    try { appendFileSync(RealtimeListener.LOG_FILE, line + "\n"); } catch {}
  }

  private logError(msg: string, err?: unknown): void {
    const line = `[${this.ts()}] ${msg}`;
    console.error(line, err);
    try { appendFileSync(RealtimeListener.LOG_FILE, line + (err ? ` ${err}` : "") + "\n"); } catch {}
  }

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
          this.connectedAt = Date.now();
          const downtime = this.disconnectedAt
            ? ((this.connectedAt - this.disconnectedAt) / 1000).toFixed(1)
            : null;
          this.log(
            `Realtime listener connected (attempt ${this.reconnectAttempts})` +
              (downtime ? ` (was down for ${downtime}s)` : "")
          );
          // Only reset backoff after connection is stable for 30s
          if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
          this.stabilityTimer = setTimeout(() => {
            if (this.reconnectAttempts > 0) {
              this.log(`Connection stable for ${RealtimeListener.STABLE_CONNECTION_MS / 1000}s, resetting backoff (was attempt ${this.reconnectAttempts})`);
            }
            this.reconnectAttempts = 0;
          }, RealtimeListener.STABLE_CONNECTION_MS);
          if (isReconnect) {
            this.catchUpMissedMessages(onMessage);
          }
        } else if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
          if (this.stabilityTimer) {
            clearTimeout(this.stabilityTimer);
            this.stabilityTimer = null;
          }
          this.disconnectedAt = Date.now();
          const uptime = this.connectedAt
            ? ((this.disconnectedAt - this.connectedAt) / 1000).toFixed(1)
            : null;
          const errDetail = err != null
            ? (typeof err === "object" ? JSON.stringify(err) : String(err))
            : "no error detail";
          this.logError(
            `Realtime listener ${status} (uptime: ${uptime ?? "?"}s) [${errDetail}]`
          );
          if (!this.disposed) this.reconnect(onMessage);
        }
      });
  }

  broadcastAgentEvent(channelId: string, event: AgentEvent, messageId: string): void {
    let channel = this.broadcastChannels.get(channelId);
    if (!channel) {
      channel = this.supabase.channel(`channel:${channelId}`);
      const ready = new Promise<void>((resolve) => {
        channel!.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            console.log(`[realtime] broadcast channel ready (channel:${channelId})`);
            resolve();
          }
        });
      });
      this.broadcastReady.set(channelId, ready);
      this.broadcastChannels.set(channelId, channel);
    }
    const ch = channel;
    this.broadcastReady.get(channelId)!.then(() => {
      ch.send({
        type: "broadcast",
        event: "agent_event",
        payload: { ...event, message_id: messageId },
      });
    });
  }

  unsubscribe(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    this.supabase.removeChannel(this.listenerChannel);
    this.listenerChannel = this.supabase.channel("messages:all");
    for (const channel of this.broadcastChannels.values()) {
      this.supabase.removeChannel(channel);
    }
    this.broadcastChannels.clear();
    this.broadcastReady.clear();
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
      this.log(`Attempting to reconnect (attempt ${this.reconnectAttempts})...`);
      this.supabase.removeChannel(this.listenerChannel);
      this.listenerChannel = this.supabase.channel("messages:all");
      this.subscribe(onMessage);
    }, delay);
  }
}
