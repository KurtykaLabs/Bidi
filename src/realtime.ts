import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { AgentEvent } from "./agent.js";
import { getHumanMessagesSince } from "./db.js";
import { trackEvent, captureError } from "./analytics.js";

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
  private static readonly WEBSOCKET_RESET_THRESHOLD = 5;

  private ts(): string {
    return new Date().toLocaleString();
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) {
      return err.stack ?? `${err.name}: ${err.message}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  private log(msg: string): void {
    console.log(`[${this.ts()}] ${msg}`);
  }

  private logError(msg: string, err?: unknown): void {
    if (err !== undefined) {
      console.error(`[${this.ts()}] ${msg}`, err);
    } else {
      console.error(`[${this.ts()}] ${msg}`);
    }
  }

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.listenerChannel = this.supabase.channel("messages:all");
  }

  subscribe(onMessage: (row: MessageRow) => void | Promise<void>): void {
    this.disposed = false;
    const currentChannel = this.listenerChannel;
    currentChannel
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          if (currentChannel !== this.listenerChannel) return;
          const row = payload.new as MessageRow;
          if (row.role !== "human") return;
          if (row.created_at) this.lastSeenAt = row.created_at;
          Promise.resolve(onMessage(row)).catch((err: unknown) => {
            captureError(err, { context: "realtime_onMessage" });
            console.error(`[realtime] onMessage error: ${this.formatError(err)}`);
          });
        }
      )
      .subscribe((status, err) => {
        if (currentChannel !== this.listenerChannel) return;
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
          trackEvent("realtime_connected", {
            attempt: this.reconnectAttempts,
            downtimeSeconds: downtime ? parseFloat(downtime) : null,
            isReconnect,
          });
          // Only reset backoff after connection is stable for 30s
          if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
          this.stabilityTimer = setTimeout(() => {
            this.stabilityTimer = null;
            if (this.reconnectAttempts > 0) {
              this.log(`Connection stable for ${RealtimeListener.STABLE_CONNECTION_MS / 1000}s, resetting backoff (was attempt ${this.reconnectAttempts})`);
              trackEvent("realtime_stable", { previousAttempts: this.reconnectAttempts });
            }
            this.reconnectAttempts = 0;
          }, RealtimeListener.STABLE_CONNECTION_MS);
          this.stabilityTimer.unref();
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
          const errDetail = err != null ? this.formatError(err) : "no error detail";
          this.logError(
            `Realtime listener ${status} (uptime: ${uptime ?? "?"}s) [${errDetail}]`
          );
          trackEvent("realtime_disconnected", {
            status,
            uptimeSeconds: uptime ? parseFloat(uptime) : null,
            errorDetail: errDetail,
          });
          if (!this.disposed) this.reconnect(onMessage);
        }
      });
  }

  private ensureBroadcastChannel(channelId: string): RealtimeChannel {
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
    return channel;
  }

  broadcastChannelEvent(channelId: string, event: string, payload: Record<string, unknown>): void {
    const ch = this.ensureBroadcastChannel(channelId);
    this.broadcastReady.get(channelId)!.then(() => {
      ch.send({
        type: "broadcast",
        event: "channel_event",
        payload: { type: event, ...payload },
      });
    });
  }

  broadcastAgentEvent(channelId: string, event: AgentEvent, messageId: string, eventId?: string): void {
    const ch = this.ensureBroadcastChannel(channelId);
    this.broadcastReady.get(channelId)!.then(() => {
      ch.send({
        type: "broadcast",
        event: "agent_event",
        payload: { ...event, message_id: messageId, ...(eventId && { event_id: eventId }) },
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
    const oldChannel = this.listenerChannel;
    this.supabase.removeChannel(oldChannel);
    this.listenerChannel = this.supabase.channel(`messages:all:${Date.now()}`);
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
        trackEvent("realtime_catchup", { missedCount: missed.length });
        console.log(`[realtime] catching up on ${missed.length} missed message(s)`);
        for (const row of missed) {
          await Promise.resolve(onMessage(row)).catch((err: unknown) => {
            captureError(err, { context: "realtime_catchup_onMessage" });
            console.error(`[realtime] catch-up onMessage error: ${this.formatError(err)}`);
          });
        }
        const last = missed[missed.length - 1];
        if (last.created_at) this.lastSeenAt = last.created_at;
      }
    } catch (err: unknown) {
      captureError(err, { context: "realtime_catchup_query" });
      console.error(`[realtime] catch-up query failed: ${this.formatError(err)}`);
    }
  }

  private reconnect(onMessage: (row: MessageRow) => void | Promise<void>): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RealtimeListener.BASE_RECONNECT_DELAY * 2 ** this.reconnectAttempts,
      RealtimeListener.MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts++;
    trackEvent("realtime_reconnect_scheduled", { attempt: this.reconnectAttempts, delayMs: delay });
    this.log(`Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      const resetWebSocket = this.reconnectAttempts >= RealtimeListener.WEBSOCKET_RESET_THRESHOLD;

      // Swap to a fresh channel FIRST so the stale-channel guard
      // (currentChannel !== this.listenerChannel) filters any CLOSED/ERROR
      // callbacks triggered by disconnect() or removeChannel().
      const oldChannel = this.listenerChannel;
      this.listenerChannel = this.supabase.channel(`messages:all:${Date.now()}`);

      if (resetWebSocket) {
        trackEvent("realtime_websocket_reset", { attempt: this.reconnectAttempts });
        this.log(`Resetting WebSocket (attempt ${this.reconnectAttempts})...`);
        this.supabase.realtime.disconnect();
      }

      this.supabase.removeChannel(oldChannel);

      if (resetWebSocket) {
        this.supabase.realtime.connect();
      }

      trackEvent("realtime_reconnect_attempt", { attempt: this.reconnectAttempts, willResetWebSocket: resetWebSocket });
      this.log(`Reconnect attempt ${this.reconnectAttempts}...`);
      this.subscribe(onMessage);
    }, delay);
  }
}
