import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSingle = vi.fn().mockResolvedValue({ data: { id: "msg-1" }, error: null });
const mockSelect = vi.fn(() => ({ single: mockSingle }));
const mockInsert = vi.fn(() => ({ select: mockSelect }));
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockEq2 = vi.fn(() => ({ order: mockOrder }));
const mockEq = vi.fn(() => ({ eq: mockEq2 }));
const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
const mockFrom = vi.fn((table: string) => ({
  insert: mockInsert,
  select: vi.fn(() => ({ eq: mockEq })),
  update: mockUpdate,
}));

const supabase = { from: mockFrom } as any;

import {
  createMessage,
  persistEvent,
  getMessageText,
  getThreadSessionId,
  createThread,
  updateThreadActivity,
  updateMessageSessionId,
  getChannelSummary,
} from "./db.js";

const TEST_CHANNEL_ID = "ch-123";

describe("db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSingle.mockResolvedValue({ data: { id: "msg-1" }, error: null });
  });

  describe("createMessage", () => {
    it("inserts a message row and returns id", async () => {
      const id = await createMessage(supabase, TEST_CHANNEL_ID, "human");

      expect(mockFrom).toHaveBeenCalledWith("messages");
      expect(mockInsert).toHaveBeenCalledWith({
        channel_id: TEST_CHANNEL_ID,
        role: "human",
      });
      expect(id).toBe("msg-1");
    });

    it("includes thread_id when provided", async () => {
      await createMessage(supabase, TEST_CHANNEL_ID, "agent", "thread-1");

      expect(mockInsert).toHaveBeenCalledWith({
        channel_id: TEST_CHANNEL_ID,
        role: "agent",
        thread_id: "thread-1",
      });
    });

    it("omits thread_id when passed null", async () => {
      await createMessage(supabase, TEST_CHANNEL_ID, "agent", null);

      expect(mockInsert).toHaveBeenCalledWith({
        channel_id: TEST_CHANNEL_ID,
        role: "agent",
      });
    });

    it("throws on DB error", async () => {
      mockSingle.mockResolvedValue({ data: null, error: { message: "DB error" } });

      await expect(
        createMessage(supabase, TEST_CHANNEL_ID, "human")
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("persistEvent", () => {
    it("inserts an event row under a message", async () => {
      const plainInsert = vi.fn().mockResolvedValue({ error: null });
      mockFrom.mockReturnValueOnce({ insert: plainInsert });

      await persistEvent(supabase, "msg-1", "text", { text: "Hello" });

      expect(mockFrom).toHaveBeenCalledWith("events");
      expect(plainInsert).toHaveBeenCalledWith({
        message_id: "msg-1",
        type: "text",
        payload: { text: "Hello" },
      });
    });

    it("throws on DB error", async () => {
      const plainInsert = vi.fn().mockResolvedValue({ error: { message: "DB error" } });
      mockFrom.mockReturnValueOnce({ insert: plainInsert });

      await expect(
        persistEvent(supabase, "msg-1", "text", { text: "Hello" })
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("getMessageText", () => {
    it("returns text from the first text event", async () => {
      mockSingle.mockResolvedValue({
        data: { payload: { text: "Hello" } },
        error: null,
      });

      const text = await getMessageText(supabase, "msg-1");
      expect(text).toBe("Hello");
    });

    it("returns null on error", async () => {
      mockSingle.mockResolvedValue({
        data: null,
        error: { message: "not found" },
      });

      const text = await getMessageText(supabase, "msg-1");
      expect(text).toBeNull();
    });

    it("returns null when payload has no text field", async () => {
      mockSingle.mockResolvedValue({
        data: { payload: {} },
        error: null,
      });

      const text = await getMessageText(supabase, "msg-1");
      expect(text).toBeNull();
    });
  });

  describe("getThreadSessionId", () => {
    it("returns session_id from most recent agent message", async () => {
      mockSingle.mockResolvedValue({
        data: { session_id: "sess-1" },
        error: null,
      });

      const sid = await getThreadSessionId(supabase, "thread-1");
      expect(sid).toBe("sess-1");
    });

    it("returns null when no agent messages exist", async () => {
      mockSingle.mockResolvedValue({
        data: null,
        error: { message: "not found" },
      });

      const sid = await getThreadSessionId(supabase, "thread-1");
      expect(sid).toBeNull();
    });

    it("returns null when session_id is null on the message row", async () => {
      mockSingle.mockResolvedValue({
        data: { session_id: null },
        error: null,
      });

      const sid = await getThreadSessionId(supabase, "thread-1");
      expect(sid).toBeNull();
    });
  });

  describe("createThread", () => {
    it("inserts thread row and returns id", async () => {
      mockSingle.mockResolvedValue({ data: { id: "thread-1" }, error: null });

      const id = await createThread(supabase, TEST_CHANNEL_ID);

      expect(mockFrom).toHaveBeenCalledWith("threads");
      expect(mockInsert).toHaveBeenCalledWith({
        channel_id: TEST_CHANNEL_ID,
      });
      expect(id).toBe("thread-1");
    });

    it("throws on DB error", async () => {
      mockSingle.mockResolvedValue({ data: null, error: { message: "DB error" } });

      await expect(
        createThread(supabase, TEST_CHANNEL_ID)
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("updateThreadActivity", () => {
    it("calls update on threads table", async () => {
      const mockEqResolved = vi.fn().mockResolvedValue({ error: null });
      mockUpdate.mockReturnValueOnce({ eq: mockEqResolved });

      await updateThreadActivity(supabase, "thread-1");

      expect(mockFrom).toHaveBeenCalledWith("threads");
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ last_activity_at: expect.any(String) })
      );
      expect(mockEqResolved).toHaveBeenCalledWith("id", "thread-1");
    });

    it("throws on DB error", async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({ error: { message: "DB error" } }),
      });

      await expect(
        updateThreadActivity(supabase, "thread-1")
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("updateMessageSessionId", () => {
    it("calls update on messages table", async () => {
      const mockEqResolved = vi.fn().mockResolvedValue({ error: null });
      mockUpdate.mockReturnValueOnce({ eq: mockEqResolved });

      await updateMessageSessionId(supabase, "msg-1", "sess-1");

      expect(mockFrom).toHaveBeenCalledWith("messages");
      expect(mockUpdate).toHaveBeenCalledWith({ session_id: "sess-1" });
      expect(mockEqResolved).toHaveBeenCalledWith("id", "msg-1");
    });

    it("throws on DB error", async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({ error: { message: "DB error" } }),
      });

      await expect(
        updateMessageSessionId(supabase, "msg-1", "sess-1")
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("getChannelSummary", () => {
    it("returns formatted summary of recent channel messages", async () => {
      const mockIsNull = vi.fn(() => ({
        order: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue({
            data: [
              { role: "agent", events: [{ payload: { text: "Hi there!" } }] },
              { role: "human", events: [{ payload: { text: "Hello" } }] },
            ],
            error: null,
          }),
        })),
      }));
      const mockEqChannel = vi.fn(() => ({ is: mockIsNull }));
      const mockSelectSummary = vi.fn(() => ({ eq: mockEqChannel }));
      mockFrom.mockReturnValueOnce({ select: mockSelectSummary });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);

      expect(mockFrom).toHaveBeenCalledWith("messages");
      expect(mockSelectSummary).toHaveBeenCalledWith("role, events(payload)");
      expect(summary).toBe("human: Hello\nagent: Hi there!");
    });

    it("returns null on DB error", async () => {
      const mockIsNull = vi.fn(() => ({
        order: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue({ data: null, error: { message: "DB error" } }),
        })),
      }));
      const mockEqChannel = vi.fn(() => ({ is: mockIsNull }));
      const mockSelectSummary = vi.fn(() => ({ eq: mockEqChannel }));
      mockFrom.mockReturnValueOnce({ select: mockSelectSummary });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);
      expect(summary).toBeNull();
    });

    it("returns null when no messages exist", async () => {
      const mockIsNull = vi.fn(() => ({
        order: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      }));
      const mockEqChannel = vi.fn(() => ({ is: mockIsNull }));
      const mockSelectSummary = vi.fn(() => ({ eq: mockEqChannel }));
      mockFrom.mockReturnValueOnce({ select: mockSelectSummary });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);
      expect(summary).toBeNull();
    });

    it("skips messages with no text in events", async () => {
      const mockIsNull = vi.fn(() => ({
        order: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue({
            data: [
              { role: "human", events: [{ payload: { text: "Follow up" } }] },
              { role: "agent", events: [] },
              { role: "human", events: [{ payload: { text: "Hello" } }] },
            ],
            error: null,
          }),
        })),
      }));
      const mockEqChannel = vi.fn(() => ({ is: mockIsNull }));
      const mockSelectSummary = vi.fn(() => ({ eq: mockEqChannel }));
      mockFrom.mockReturnValueOnce({ select: mockSelectSummary });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);
      expect(summary).toBe("human: Hello\nhuman: Follow up");
    });

    it("respects custom limit parameter", async () => {
      const mockLimitFn = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockIsNull = vi.fn(() => ({
        order: vi.fn(() => ({ limit: mockLimitFn })),
      }));
      const mockEqChannel = vi.fn(() => ({ is: mockIsNull }));
      const mockSelectSummary = vi.fn(() => ({ eq: mockEqChannel }));
      mockFrom.mockReturnValueOnce({ select: mockSelectSummary });

      await getChannelSummary(supabase, TEST_CHANNEL_ID, 5);
      expect(mockLimitFn).toHaveBeenCalledWith(5);
    });
  });
});
