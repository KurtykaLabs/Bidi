import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.fn();
const mockUnsubscribe = vi.fn();
const mockSubscribe = vi.fn((cb?: (status: string) => void) => {
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

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    channel: vi.fn(() => mockChannel),
    from: mockFrom,
  })),
}));

import { Chat } from "./chat.js";

describe("Chat", () => {
  let chat: Chat;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ error: null });
    chat = new Chat("https://test.supabase.co", "test-key");
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

  describe("unsubscribe", () => {
    it("calls channel unsubscribe", () => {
      chat.unsubscribe();
      expect(mockUnsubscribe).toHaveBeenCalled();
    });
  });
});
