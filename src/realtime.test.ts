import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let subscribeCallback: ((status: string, err?: Error) => void) | undefined;

const mockSend = vi.fn();
const mockUnsubscribe = vi.fn();
const mockSubscribe = vi.fn((cb?: (status: string, err?: Error) => void) => {
  subscribeCallback = cb;
  if (cb) cb("SUBSCRIBED");
  return mockChannel;
});
const mockOn = vi.fn(() => mockChannel);
const mockChannel = {
  on: mockOn,
  subscribe: mockSubscribe,
  send: mockSend,
  unsubscribe: mockUnsubscribe,
};

const mockChannelFactory = vi.fn(() => mockChannel);
const mockRemoveChannel = vi.fn();
const mockDisconnect = vi.fn();
const mockConnect = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

vi.mock("./db.js", () => ({
  getHumanMessagesSince: vi.fn().mockResolvedValue([]),
}));

import { RealtimeListener } from "./realtime.js";

const mockSupabase = {
  channel: mockChannelFactory,
  removeChannel: mockRemoveChannel,
  realtime: { disconnect: mockDisconnect, connect: mockConnect },
} as any;

describe("RealtimeListener", () => {
  let listener: RealtimeListener;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribeCallback = undefined;
    listener = new RealtimeListener(mockSupabase);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("subscribe", () => {
    it("listens on messages table with no channel_id filter", () => {
      listener.subscribe(vi.fn());

      expect(mockOn).toHaveBeenCalledWith(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        expect.any(Function)
      );
    });

    it("fires callback for human role messages", () => {
      const onMessage = vi.fn();
      listener.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({
        new: { id: "msg-1", role: "human", channel_id: "ch-1", parent_message_id: null, created_at: "2026-01-01T00:00:00Z" },
      });

      expect(onMessage).toHaveBeenCalledWith({
        id: "msg-1",
        role: "human",
        channel_id: "ch-1",
        parent_message_id: null,
        created_at: "2026-01-01T00:00:00Z",
      });
    });

    it("ignores agent role messages", () => {
      const onMessage = vi.fn();
      listener.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({
        new: { id: "msg-1", role: "agent", channel_id: "ch-1", parent_message_id: null, created_at: "2026-01-01T00:00:00Z" },
      });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it("passes through parent_message_id when present", () => {
      const onMessage = vi.fn();
      listener.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({
        new: { id: "msg-2", role: "human", channel_id: "ch-1", parent_message_id: "thread-1", created_at: "2026-01-01T00:00:01Z" },
      });

      expect(onMessage).toHaveBeenCalledWith({
        id: "msg-2",
        role: "human",
        channel_id: "ch-1",
        parent_message_id: "thread-1",
        created_at: "2026-01-01T00:00:01Z",
      });
    });
  });

  describe("broadcastAgentEvent", () => {
    it("lazy-creates a broadcast channel on first call", async () => {
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "Hi" }, "msg-1");
      await Promise.resolve();

      expect(mockChannelFactory).toHaveBeenCalledWith("channel:ch-1");
      expect(mockSubscribe).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "agent_event",
        payload: { type: "text_delta", text: "Hi", message_id: "msg-1" },
      });
    });

    it("reuses existing broadcast channel on subsequent calls", async () => {
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "Hi" }, "msg-1");
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "there" }, "msg-1");
      await Promise.resolve();

      // channel factory called once for "messages:all" in constructor + once for "channel:ch-1"
      const channelCalls = mockChannelFactory.mock.calls.filter(
        (c: any) => c[0] === "channel:ch-1"
      );
      expect(channelCalls).toHaveLength(1);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("creates separate channels for different channelIds", () => {
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "a" }, "msg-1");
      listener.broadcastAgentEvent("ch-2", { type: "text_delta", text: "b" }, "msg-2");

      expect(mockChannelFactory).toHaveBeenCalledWith("channel:ch-1");
      expect(mockChannelFactory).toHaveBeenCalledWith("channel:ch-2");
    });

    it("spreads all event fields into payload", async () => {
      listener.broadcastAgentEvent(
        "ch-1",
        { type: "tool_use_start", name: "read_file", id: "tool-1" },
        "msg-1"
      );
      await Promise.resolve();

      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "agent_event",
        payload: {
          type: "tool_use_start",
          name: "read_file",
          id: "tool-1",
          message_id: "msg-1",
        },
      });
    });
  });

  describe("broadcastChannelEvent", () => {
    it("sends channel_event with correct payload shape", async () => {
      listener.broadcastChannelEvent("ch-1", "channel_renamed", { name: "test_channel" });
      await Promise.resolve();

      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "channel_event",
        payload: { type: "channel_renamed", name: "test_channel" },
      });
    });

    it("reuses existing broadcast channel", async () => {
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "Hi" }, "msg-1");
      listener.broadcastChannelEvent("ch-1", "channel_renamed", { name: "test_channel" });
      await Promise.resolve();

      const channelCalls = mockChannelFactory.mock.calls.filter(
        (c: any) => c[0] === "channel:ch-1"
      );
      expect(channelCalls).toHaveLength(1);
    });
  });

  describe("reconnect", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it.each(["TIMED_OUT", "CHANNEL_ERROR", "CLOSED"])(
      "triggers reconnect on %s",
      (status) => {
        listener.subscribe(vi.fn());
        subscribeCallback!(status, new Error("fail"));

        vi.advanceTimersByTime(3000);

        expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
        expect(mockChannelFactory).toHaveBeenCalledTimes(2);
        expect(mockSubscribe).toHaveBeenCalledTimes(2);
      }
    );

    it("does not trigger reconnect on SUBSCRIBED", () => {
      listener.subscribe(vi.fn());

      vi.advanceTimersByTime(5000);

      expect(mockChannelFactory).toHaveBeenCalledTimes(1);
    });

    it("waits 3 seconds before reconnecting", () => {
      listener.subscribe(vi.fn());
      subscribeCallback!("CHANNEL_ERROR");

      vi.advanceTimersByTime(2999);
      expect(mockChannelFactory).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
    });

    it("does not schedule multiple reconnects from rapid errors", () => {
      listener.subscribe(vi.fn());

      subscribeCallback!("TIMED_OUT");
      subscribeCallback!("CHANNEL_ERROR");
      subscribeCallback!("CLOSED");

      vi.advanceTimersByTime(3000);

      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff on repeated failures", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(3000);
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(5999);
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(mockChannelFactory).toHaveBeenCalledTimes(3);

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(11999);
      expect(mockChannelFactory).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(1);
      expect(mockChannelFactory).toHaveBeenCalledTimes(4);
    });

    it("caps backoff delay at 60 seconds", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");

      for (let i = 0; i < 10; i++) {
        subscribeCallback!("CHANNEL_ERROR");
        vi.advanceTimersByTime(60_000);
      }

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(59_999);
      const countBefore = mockChannelFactory.mock.calls.length;
      vi.advanceTimersByTime(1);
      expect(mockChannelFactory).toHaveBeenCalledTimes(countBefore + 1);
    });

    it("resets backoff after 30s of stable connection", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(3000);
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);

      subscribeCallback!("SUBSCRIBED");
      // Advance past the 30s stability threshold so reconnectAttempts resets
      vi.advanceTimersByTime(30_000);

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(3000);
      expect(mockChannelFactory).toHaveBeenCalledTimes(3);
    });

    it("does not reset backoff before 30s stability threshold", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(3000);
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);

      subscribeCallback!("SUBSCRIBED");
      // Only advance 10s — not enough to reset backoff
      vi.advanceTimersByTime(10_000);

      // Error before stability timer fires — backoff should still be elevated (6s)
      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(5999);
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(mockChannelFactory).toHaveBeenCalledTimes(3);
    });

    it("uses a unique topic on reconnect to avoid Supabase channel dedup", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");
      subscribeCallback!("CHANNEL_ERROR");

      vi.advanceTimersByTime(3000);

      const topics = mockChannelFactory.mock.calls.map((c: any) => c[0]);
      const constructorTopic = topics[0];
      const reconnectTopic = topics[1];

      expect(reconnectTopic).not.toBe(constructorTopic);
      expect(reconnectTopic).toMatch(/^messages:all:\d+$/);
    });

    it("does not reset WebSocket on early reconnect attempts", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");

      // Trigger 4 failures (attempts 1-4, below threshold of 5)
      for (let i = 0; i < 4; i++) {
        subscribeCallback!("CHANNEL_ERROR");
        vi.advanceTimersByTime(60_000);
      }

      expect(mockDisconnect).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it("escalates to WebSocket reset at attempt 5", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");

      // Trigger 5 failures — attempt 5 hits the threshold
      for (let i = 0; i < 5; i++) {
        subscribeCallback!("CHANNEL_ERROR");
        vi.advanceTimersByTime(60_000);
      }

      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("resets WebSocket on every attempt at and after threshold", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      listener.subscribe(vi.fn());
      subscribeCallback!("SUBSCRIBED");

      // Burn through 4 attempts below threshold
      for (let i = 0; i < 4; i++) {
        subscribeCallback!("CHANNEL_ERROR");
        vi.advanceTimersByTime(60_000);
      }

      // Attempts 5, 6, 7 should all reset WebSocket
      for (let i = 0; i < 3; i++) {
        subscribeCallback!("CHANNEL_ERROR");
        vi.advanceTimersByTime(60_000);
      }

      expect(mockDisconnect).toHaveBeenCalledTimes(3);
      expect(mockConnect).toHaveBeenCalledTimes(3);
    });

    it("does not cascade reconnects when removeChannel triggers CLOSED on old channel", () => {
      const channels: any[] = [];
      const callbacks = new Map<object, (status: string, err?: Error) => void>();

      const localFactory = vi.fn(() => {
        const ch = {
          on: vi.fn(() => ch),
          subscribe: vi.fn((cb?: any) => {
            if (cb) callbacks.set(ch, cb);
            return ch;
          }),
          send: vi.fn(),
          unsubscribe: vi.fn(),
        };
        channels.push(ch);
        return ch;
      });

      const localRemove = vi.fn((channel: any) => {
        const cb = callbacks.get(channel);
        if (cb) cb("CLOSED");
      });

      const localSupabase = { channel: localFactory, removeChannel: localRemove } as any;
      const freshListener = new RealtimeListener(localSupabase);
      const onMessage = vi.fn();
      freshListener.subscribe(onMessage);

      // Trigger connected state
      const ch0cb = callbacks.get(channels[0])!;
      ch0cb("SUBSCRIBED");

      // Simulate disconnect
      ch0cb("CHANNEL_ERROR");

      // Fire reconnect timer — removeChannel will trigger CLOSED on old channel
      vi.advanceTimersByTime(3000);

      // New channel should be subscribed
      const ch1cb = callbacks.get(channels[1])!;
      ch1cb("SUBSCRIBED");

      // No cascading reconnect timer should tear down the new channel
      vi.advanceTimersByTime(60_000);

      // Only 2 channels: constructor + 1 reconnect (no cascade)
      expect(channels.length).toBe(2);
    });
  });

  describe("unsubscribe", () => {
    it("removes listener channel via removeChannel and reinitializes", () => {
      listener.unsubscribe();
      expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
      // Should create a fresh channel so resubscribe works
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
    });

    it("removes old channel before creating new one with unique topic", () => {
      const callOrder: string[] = [];
      mockRemoveChannel.mockImplementation(() => callOrder.push("remove"));
      mockChannelFactory.mockImplementation((topic: string) => {
        if (callOrder.length > 0 || topic !== "messages:all") {
          callOrder.push(`create:${topic}`);
        }
        return mockChannel;
      });

      listener.unsubscribe();

      expect(callOrder[0]).toBe("remove");
      expect(callOrder[1]).toMatch(/^create:messages:all:\d+$/);
    });

    it("cleans up broadcast channels via removeChannel", () => {
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "Hi" }, "msg-1");
      listener.broadcastAgentEvent("ch-2", { type: "text_delta", text: "Hi" }, "msg-2");

      listener.unsubscribe();

      // listener channel + 2 broadcast channels
      expect(mockRemoveChannel).toHaveBeenCalledTimes(3);
    });

    it("cancels a pending reconnect timer", () => {
      vi.useFakeTimers();
      listener.subscribe(vi.fn());
      subscribeCallback!("CHANNEL_ERROR");

      listener.unsubscribe();

      vi.advanceTimersByTime(5000);

      // 1 from constructor + 1 from unsubscribe reinit, no extra from reconnect
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
    });

    it("does not reconnect when CLOSED fires as side-effect of unsubscribe", () => {
      vi.useFakeTimers();
      listener.subscribe(vi.fn());

      listener.unsubscribe();

      subscribeCallback!("CLOSED");

      vi.advanceTimersByTime(5000);

      // 1 from constructor + 1 from unsubscribe reinit, no extra from reconnect
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
    });
  });
});
