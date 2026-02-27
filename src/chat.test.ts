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

  describe("sendMessage", () => {
    it("inserts into DB with correct sender and broadcasts", async () => {
      await chat.sendMessage("hello", "user");

      expect(mockFrom).toHaveBeenCalledWith("messages");
      expect(mockInsert).toHaveBeenCalledWith({ text: "hello", sender: "user" });
      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "message",
        payload: { text: "hello", sender: "user" },
      });
    });

    it("adds to sentMessages so own messages are deduplicated", async () => {
      const onMessage = vi.fn();
      chat.subscribe(onMessage);

      await chat.sendMessage("hello", "user");

      // Simulate the postgres_changes callback for our own message
      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({ new: { text: "hello", sender: "user" } });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it("removes from sentMessages and throws on DB error", async () => {
      mockInsert.mockResolvedValue({ error: { message: "DB error" } });

      await expect(chat.sendMessage("hello", "user")).rejects.toEqual({
        message: "DB error",
      });

      // After error, the message should be removed from sentMessages,
      // so a subsequent incoming message should NOT be deduplicated
      const onMessage = vi.fn();
      chat.subscribe(onMessage);

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({ new: { text: "hello", sender: "user" } });

      expect(onMessage).toHaveBeenCalledWith("hello", "user");
    });
  });

  describe("subscribe", () => {
    it("fires callback for external messages", () => {
      const onMessage = vi.fn();
      chat.subscribe(onMessage);

      expect(mockOn).toHaveBeenCalledWith(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        expect.any(Function)
      );

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({ new: { text: "hi there", sender: "other" } });

      expect(onMessage).toHaveBeenCalledWith("hi there", "other");
    });

    it("does not fire callback for own messages", async () => {
      const onMessage = vi.fn();
      chat.subscribe(onMessage);

      await chat.sendMessage("my message", "user");

      const postgresCallback = mockOn.mock.calls[0][2];
      postgresCallback({ new: { text: "my message", sender: "user" } });

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe("broadcastTyping", () => {
    it("sends correct payload shape", () => {
      chat.broadcastTyping("typing...", "user");

      expect(mockSend).toHaveBeenCalledWith({
        type: "broadcast",
        event: "typing",
        payload: { currentLine: "typing...", sender: "user" },
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
  });
});
