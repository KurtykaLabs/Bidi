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

const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockFrom = vi.fn(() => ({ insert: mockInsert }));
const mockChannelFactory = vi.fn(() => mockChannel);

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    channel: mockChannelFactory,
    from: mockFrom,
  })),
}));

import { Chat } from "./chat.js";

describe("Chat", () => {
  let chat: Chat;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribeCallback = undefined;
    mockInsert.mockResolvedValue({ error: null });
    chat = new Chat("https://test.supabase.co", "test-key");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("broadcastAgentEvent", () => {
    it("sends correct payload shape with sender", () => {
      chat.broadcastAgentEvent({ type: "text_delta", text: "Hello" }, "agent");

      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "agent_event",
        payload: { type: "text_delta", text: "Hello", sender: "agent" },
      });
    });

    it("spreads all event fields into payload", () => {
      chat.broadcastAgentEvent(
        { type: "tool_use_start", name: "read_file", id: "tool-1" },
        "agent"
      );

      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "agent_event",
        payload: {
          type: "tool_use_start",
          name: "read_file",
          id: "tool-1",
          sender: "agent",
        },
      });
    });
  });

  describe("persistAgentEvent", () => {
    it("inserts milestone events into agent_events table", async () => {
      await chat.persistAgentEvent(
        { type: "assistant_message", text: "Hello" }
      );

      expect(mockFrom).toHaveBeenCalledWith("agent_events");
      expect(mockInsert).toHaveBeenCalledWith({
        type: "assistant_message",
        payload: { text: "Hello" },
      });
    });

    it("persists tool_use_start events", async () => {
      await chat.persistAgentEvent(
        { type: "tool_use_start", name: "read_file", id: "tool-1" }
      );

      expect(mockFrom).toHaveBeenCalledWith("agent_events");
      expect(mockInsert).toHaveBeenCalledWith({
        type: "tool_use_start",
        payload: { name: "read_file", id: "tool-1" },
      });
    });

    it("persists tool_result events", async () => {
      await chat.persistAgentEvent(
        { type: "tool_result", tool_use_id: "tool-1", content: "done" }
      );

      expect(mockFrom).toHaveBeenCalledWith("agent_events");
      expect(mockInsert).toHaveBeenCalledWith({
        type: "tool_result",
        payload: { tool_use_id: "tool-1", content: "done" },
      });
    });

    it("persists result events", async () => {
      await chat.persistAgentEvent(
        { type: "result", session_id: "sess-1", duration_ms: 500 }
      );

      expect(mockFrom).toHaveBeenCalledWith("agent_events");
    });

    it("persists tool_use_summary events", async () => {
      await chat.persistAgentEvent(
        { type: "tool_use_summary", summary: "Searched the web" }
      );

      expect(mockFrom).toHaveBeenCalledWith("agent_events");
      expect(mockInsert).toHaveBeenCalledWith({
        type: "tool_use_summary",
        payload: { summary: "Searched the web" },
      });
    });

    it("skips non-milestone events", async () => {
      await chat.persistAgentEvent({ type: "text_delta", text: "hi" });
      await chat.persistAgentEvent({ type: "thinking_start" });
      await chat.persistAgentEvent({ type: "thinking_delta", text: "hmm" });
      await chat.persistAgentEvent({ type: "thinking_stop" });
      await chat.persistAgentEvent({ type: "tool_use_delta", input_json: "{}" });
      await chat.persistAgentEvent({ type: "tool_use_stop" });
      await chat.persistAgentEvent({ type: "session_id", id: "s" });

      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("throws on DB error", async () => {
      mockInsert.mockResolvedValue({ error: { message: "DB error" } });

      await expect(
        chat.persistAgentEvent(
          { type: "assistant_message", text: "Hello" }
        )
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("subscribe", () => {
    it("listens on human_events table", () => {
      chat.subscribe(vi.fn());

      expect(mockOn).toHaveBeenCalledWith(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "human_events" },
        expect.any(Function)
      );
    });

    it("fires callback with text from payload", () => {
      const onMessage = vi.fn();
      chat.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({
        new: { type: "message", payload: { text: "hi there" } },
      });

      expect(onMessage).toHaveBeenCalledWith("hi there");
    });

    it("ignores events with missing or empty text", () => {
      const onMessage = vi.fn();
      chat.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({ new: { type: "message", payload: {} } });
      postgresCallback({ new: { type: "message", payload: { text: "" } } });
      postgresCallback({ new: { type: "message", payload: { text: "   " } } });

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe("reconnect", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it.each(["TIMED_OUT", "CHANNEL_ERROR", "CLOSED"])(
      "triggers reconnect on %s",
      (status) => {
        chat.subscribe(vi.fn());
        subscribeCallback!(status, new Error("fail"));

        vi.advanceTimersByTime(3000);

        expect(mockUnsubscribe).toHaveBeenCalled();
        expect(mockChannelFactory).toHaveBeenCalledTimes(2);
        expect(mockSubscribe).toHaveBeenCalledTimes(2);
      }
    );

    it("does not trigger reconnect on SUBSCRIBED", () => {
      chat.subscribe(vi.fn());

      vi.advanceTimersByTime(5000);

      expect(mockChannelFactory).toHaveBeenCalledTimes(1);
    });

    it("waits 3 seconds before reconnecting", () => {
      chat.subscribe(vi.fn());
      subscribeCallback!("CHANNEL_ERROR");

      vi.advanceTimersByTime(2999);
      expect(mockChannelFactory).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
    });

    it("does not schedule multiple reconnects from rapid errors", () => {
      chat.subscribe(vi.fn());

      subscribeCallback!("TIMED_OUT");
      subscribeCallback!("CHANNEL_ERROR");
      subscribeCallback!("CLOSED");

      vi.advanceTimersByTime(3000);

      expect(mockChannelFactory).toHaveBeenCalledTimes(2);
    });

    it("re-subscribes with the same onMessage callback after reconnect", () => {
      const onMessage = vi.fn();
      chat.subscribe(onMessage);
      subscribeCallback!("CHANNEL_ERROR");

      vi.advanceTimersByTime(3000);

      expect(mockOn).toHaveBeenCalledTimes(2);
      expect(mockOn.mock.calls[1][2]).toBeDefined();
    });

    it("uses exponential backoff on repeated failures", () => {
      mockSubscribe.mockImplementation((cb?: any) => {
        subscribeCallback = cb;
        return mockChannel;
      });

      chat.subscribe(vi.fn());
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

      chat.subscribe(vi.fn());
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

      chat.subscribe(vi.fn());
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
    it("calls channel unsubscribe", () => {
      chat.unsubscribe();
      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it("cancels a pending reconnect timer", () => {
      vi.useFakeTimers();
      chat.subscribe(vi.fn());
      subscribeCallback!("CHANNEL_ERROR");

      chat.unsubscribe();

      vi.advanceTimersByTime(5000);

      expect(mockChannelFactory).toHaveBeenCalledTimes(1);
    });

    it("does not reconnect when CLOSED fires as side-effect of unsubscribe", () => {
      vi.useFakeTimers();
      chat.subscribe(vi.fn());

      chat.unsubscribe();

      subscribeCallback!("CLOSED");

      vi.advanceTimersByTime(5000);

      expect(mockChannelFactory).toHaveBeenCalledTimes(1);
    });
  });
});
