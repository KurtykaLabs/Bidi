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

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import { RealtimeListener } from "./realtime.js";

const mockSupabase = { channel: mockChannelFactory, removeChannel: mockRemoveChannel } as any;

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
        new: { id: "msg-1", role: "human", channel_id: "ch-1", thread_id: null },
      });

      expect(onMessage).toHaveBeenCalledWith({
        id: "msg-1",
        role: "human",
        channel_id: "ch-1",
        thread_id: null,
      });
    });

    it("ignores agent role messages", () => {
      const onMessage = vi.fn();
      listener.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({
        new: { id: "msg-1", role: "agent", channel_id: "ch-1", thread_id: null },
      });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it("passes through thread_id when present", () => {
      const onMessage = vi.fn();
      listener.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({
        new: { id: "msg-2", role: "human", channel_id: "ch-1", thread_id: "thread-1" },
      });

      expect(onMessage).toHaveBeenCalledWith({
        id: "msg-2",
        role: "human",
        channel_id: "ch-1",
        thread_id: "thread-1",
      });
    });
  });

  describe("broadcastAgentEvent", () => {
    it("lazy-creates a broadcast channel on first call", () => {
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "Hi" }, "msg-1");

      expect(mockChannelFactory).toHaveBeenCalledWith("channel:ch-1");
      expect(mockSubscribe).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "agent_event",
        payload: { type: "text_delta", text: "Hi", message_id: "msg-1" },
      });
    });

    it("reuses existing broadcast channel on subsequent calls", () => {
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "Hi" }, "msg-1");
      listener.broadcastAgentEvent("ch-1", { type: "text_delta", text: "there" }, "msg-1");

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

    it("spreads all event fields into payload", () => {
      listener.broadcastAgentEvent(
        "ch-1",
        { type: "tool_use_start", name: "read_file", id: "tool-1" },
        "msg-1"
      );

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

    it("resets backoff after successful reconnect", () => {
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

      subscribeCallback!("CHANNEL_ERROR");
      vi.advanceTimersByTime(3000);
      expect(mockChannelFactory).toHaveBeenCalledTimes(3);
    });
  });

  describe("unsubscribe", () => {
    it("removes listener channel via removeChannel", () => {
      listener.unsubscribe();
      expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
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

      expect(mockChannelFactory).toHaveBeenCalledTimes(1);
    });

    it("does not reconnect when CLOSED fires as side-effect of unsubscribe", () => {
      vi.useFakeTimers();
      listener.subscribe(vi.fn());

      listener.unsubscribe();

      subscribeCallback!("CLOSED");

      vi.advanceTimersByTime(5000);

      expect(mockChannelFactory).toHaveBeenCalledTimes(1);
    });
  });
});
