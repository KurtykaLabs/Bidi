import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSingle = vi.fn().mockResolvedValue({ data: { id: "msg-1" }, error: null });
const mockSelect = vi.fn(() => ({ single: mockSingle }));
const mockInsert = vi.fn(() => ({ select: mockSelect }));
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockEq2 = vi.fn(() => ({ order: mockOrder }));
const mockEq = vi.fn(() => ({ eq: mockEq2 }));
const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
const mockEqSingle = vi.fn(() => ({ single: mockSingle }));
const mockFrom = vi.fn((table: string) => ({
  insert: mockInsert,
  select: vi.fn(() => ({ eq: table === "channels" ? mockEqSingle : mockEq })),
  update: mockUpdate,
}));

const supabase = { from: mockFrom } as any;

import {
  createMessage,
  persistEvent,
  getMessageText,
  getChannelSessionId,
  updateChannelName,
  updateChannelSessionId,
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

    it("includes parent_message_id when provided", async () => {
      await createMessage(supabase, TEST_CHANNEL_ID, "agent", "parent-1");

      expect(mockInsert).toHaveBeenCalledWith({
        channel_id: TEST_CHANNEL_ID,
        role: "agent",
        parent_message_id: "parent-1",
      });
    });

    it("omits parent_message_id when passed null", async () => {
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

  describe("getChannelSessionId", () => {
    it("returns session_id from channel", async () => {
      mockSingle.mockResolvedValue({
        data: { session_id: "sess-1" },
        error: null,
      });

      const sid = await getChannelSessionId(supabase, TEST_CHANNEL_ID);
      expect(sid).toBe("sess-1");
      expect(mockFrom).toHaveBeenCalledWith("channels");
    });

    it("returns null when channel not found", async () => {
      mockSingle.mockResolvedValue({
        data: null,
        error: { message: "not found" },
      });

      const sid = await getChannelSessionId(supabase, TEST_CHANNEL_ID);
      expect(sid).toBeNull();
    });

    it("returns null when session_id is null on the channel", async () => {
      mockSingle.mockResolvedValue({
        data: { session_id: null },
        error: null,
      });

      const sid = await getChannelSessionId(supabase, TEST_CHANNEL_ID);
      expect(sid).toBeNull();
    });
  });

  describe("updateChannelName", () => {
    it("returns true when name was updated from default", async () => {
      const mockSelectFn = vi.fn().mockResolvedValue({ data: [{ id: TEST_CHANNEL_ID }], error: null });
      const mockEqName = vi.fn(() => ({ select: mockSelectFn }));
      const mockEqId = vi.fn(() => ({ eq: mockEqName }));
      mockUpdate.mockReturnValueOnce({ eq: mockEqId });

      const result = await updateChannelName(supabase, TEST_CHANNEL_ID, "project_discussion");

      expect(mockFrom).toHaveBeenCalledWith("channels");
      expect(mockUpdate).toHaveBeenCalledWith({ name: "project_discussion" });
      expect(mockEqId).toHaveBeenCalledWith("id", TEST_CHANNEL_ID);
      expect(mockEqName).toHaveBeenCalledWith("name", "new_channel");
      expect(result).toBe(true);
    });

    it("returns false when name was already set", async () => {
      const mockSelectFn = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockEqName = vi.fn(() => ({ select: mockSelectFn }));
      const mockEqId = vi.fn(() => ({ eq: mockEqName }));
      mockUpdate.mockReturnValueOnce({ eq: mockEqId });

      const result = await updateChannelName(supabase, TEST_CHANNEL_ID, "project_discussion");
      expect(result).toBe(false);
    });

    it("throws on DB error", async () => {
      const mockSelectFn = vi.fn().mockResolvedValue({ error: { message: "DB error" } });
      const mockEqName = vi.fn(() => ({ select: mockSelectFn }));
      const mockEqId = vi.fn(() => ({ eq: mockEqName }));
      mockUpdate.mockReturnValueOnce({ eq: mockEqId });

      await expect(
        updateChannelName(supabase, TEST_CHANNEL_ID, "project_discussion")
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("updateChannelSessionId", () => {
    it("calls update on channels table", async () => {
      const mockEqResolved = vi.fn().mockResolvedValue({ error: null });
      mockUpdate.mockReturnValueOnce({ eq: mockEqResolved });

      await updateChannelSessionId(supabase, TEST_CHANNEL_ID, "sess-1");

      expect(mockFrom).toHaveBeenCalledWith("channels");
      expect(mockUpdate).toHaveBeenCalledWith({ session_id: "sess-1" });
      expect(mockEqResolved).toHaveBeenCalledWith("id", TEST_CHANNEL_ID);
    });

    it("throws on DB error", async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({ error: { message: "DB error" } }),
      });

      await expect(
        updateChannelSessionId(supabase, TEST_CHANNEL_ID, "sess-1")
      ).rejects.toEqual({ message: "DB error" });
    });
  });

  describe("getChannelSummary", () => {
    function mockSummaryChain(resolvedValue: any) {
      const mockLimitFn = vi.fn().mockResolvedValue(resolvedValue);
      const mockOrderFn = vi.fn(() => ({ limit: mockLimitFn }));
      const mockInFn = vi.fn(() => ({ order: mockOrderFn }));
      const mockIsNull = vi.fn(() => ({ in: mockInFn }));
      const mockEqChannel = vi.fn(() => ({ is: mockIsNull }));
      const mockSelectSummary = vi.fn(() => ({ eq: mockEqChannel }));
      mockFrom.mockReturnValueOnce({ select: mockSelectSummary });
      return { mockSelectSummary, mockLimitFn };
    }

    it("returns formatted summary of recent channel messages", async () => {
      const { mockSelectSummary } = mockSummaryChain({
        data: [
          { role: "agent", events: [{ type: "assistant_message", payload: { text: "Hi there!" } }] },
          { role: "human", events: [{ type: "text", payload: { text: "Hello" } }] },
        ],
        error: null,
      });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);

      expect(mockFrom).toHaveBeenCalledWith("messages");
      expect(mockSelectSummary).toHaveBeenCalledWith("role, events!inner(type, payload)");
      expect(summary).toBe("human: Hello\nagent: Hi there!");
    });

    it("returns null on DB error", async () => {
      mockSummaryChain({ data: null, error: { message: "DB error" } });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);
      expect(summary).toBeNull();
    });

    it("returns null when no messages exist", async () => {
      mockSummaryChain({ data: [], error: null });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);
      expect(summary).toBeNull();
    });

    it("skips messages with no text in events", async () => {
      mockSummaryChain({
        data: [
          { role: "human", events: [{ type: "text", payload: { text: "Follow up" } }] },
          { role: "agent", events: [] },
          { role: "human", events: [{ type: "text", payload: { text: "Hello" } }] },
        ],
        error: null,
      });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);
      expect(summary).toBe("human: Hello\nhuman: Follow up");
    });

    it("respects custom limit parameter", async () => {
      const { mockLimitFn } = mockSummaryChain({ data: [], error: null });

      await getChannelSummary(supabase, TEST_CHANNEL_ID, 5);
      expect(mockLimitFn).toHaveBeenCalledWith(5);
    });

    it("finds text event among multiple event types", async () => {
      mockSummaryChain({
        data: [
          {
            role: "agent",
            events: [
              { type: "tool_use_start", payload: { name: "bash" } },
              { type: "assistant_message", payload: { text: "Done!" } },
            ],
          },
        ],
        error: null,
      });

      const summary = await getChannelSummary(supabase, TEST_CHANNEL_ID);
      expect(summary).toBe("agent: Done!");
    });
  });
});
