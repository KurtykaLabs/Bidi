import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock analytics
vi.mock("./analytics.js", () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock node:readline
const mockQuestion = vi.fn();
const mockClose = vi.fn();
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  authenticate,
  ensureProfile,
  findExistingAgent,
  promptAgentName,
  createAgent,
  findSpaceForAgent,
  type Profile,
  type Agent,
} from "./auth.js";

function mockPromptResponse(answer: string) {
  mockQuestion.mockImplementationOnce((_q: string, cb: (a: string) => void) => {
    cb(answer);
  });
}

function createMockSupabase(overrides: Record<string, any> = {}) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: null },
      }),
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1" } },
      }),
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      verifyOtp: vi.fn().mockResolvedValue({
        data: {
          session: { user: { id: "user-1", email: "test@example.com" } },
        },
        error: null,
      }),
      ...overrides.auth,
    },
    from: vi.fn(),
    rpc: vi.fn(),
    ...overrides,
  } as any;
}

describe("auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authenticate", () => {
    it("returns user id when session exists", async () => {
      const supabase = createMockSupabase();
      supabase.auth.getSession.mockResolvedValue({
        data: {
          session: { user: { id: "user-1", email: "test@example.com" } },
        },
      });

      const id = await authenticate(supabase);

      expect(id).toBe("user-1");
      expect(supabase.auth.signInWithOtp).not.toHaveBeenCalled();
      expect(supabase.auth.verifyOtp).not.toHaveBeenCalled();
    });

    it("runs OTP flow when no session exists", async () => {
      const supabase = createMockSupabase();
      mockPromptResponse("test@example.com");
      mockPromptResponse("123456");

      const id = await authenticate(supabase);

      expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
        email: "test@example.com",
      });
      expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
        email: "test@example.com",
        token: "123456",
        type: "email",
      });
      expect(id).toBe("user-1");
    });

    it("throws when OTP send fails", async () => {
      const supabase = createMockSupabase({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          signInWithOtp: vi.fn().mockResolvedValue({
            error: { message: "Rate limited" },
          }),
        },
      });
      mockPromptResponse("test@example.com");

      await expect(authenticate(supabase)).rejects.toThrow(
        "Failed to send OTP: Rate limited"
      );
    });

    it("throws when OTP verification fails", async () => {
      const supabase = createMockSupabase({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
          verifyOtp: vi.fn().mockResolvedValue({
            data: { session: null },
            error: { message: "Invalid code" },
          }),
        },
      });
      mockPromptResponse("test@example.com");
      mockPromptResponse("000000");

      await expect(authenticate(supabase)).rejects.toThrow(
        "Verification failed: Invalid code"
      );
    });

    it("throws when verification returns no session", async () => {
      const supabase = createMockSupabase({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
          verifyOtp: vi.fn().mockResolvedValue({
            data: { session: null },
            error: null,
          }),
        },
      });
      mockPromptResponse("test@example.com");
      mockPromptResponse("123456");

      await expect(authenticate(supabase)).rejects.toThrow(
        "No session returned after verification"
      );
    });
  });

  describe("ensureProfile", () => {
    it("returns existing profile with username", async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: "user-1", username: "casey", email: "test@example.com" },
        error: null,
      });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({ select: mockSelect });

      const profile = await ensureProfile(supabase);

      expect(profile.username).toBe("casey");
      expect(supabase.from).toHaveBeenCalledWith("profiles");
    });

    it("prompts for username when null", async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: "user-1", username: null, email: "test@example.com" },
        error: null,
      });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));
      const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));
      const supabase = createMockSupabase();
      supabase.from
        .mockReturnValueOnce({ select: mockSelect })
        .mockReturnValueOnce({ update: mockUpdate });

      mockPromptResponse("newuser");

      const profile = await ensureProfile(supabase);

      expect(profile.username).toBe("newuser");
      expect(mockUpdate).toHaveBeenCalledWith({ username: "newuser" });
    });

    it("throws when not authenticated", async () => {
      const supabase = createMockSupabase({
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
        },
      });

      await expect(ensureProfile(supabase)).rejects.toThrow("Not authenticated");
    });

    it("throws when profile fetch fails", async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: "not found" },
      });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({ select: mockSelect });

      await expect(ensureProfile(supabase)).rejects.toThrow(
        "Failed to fetch profile: not found"
      );
    });
  });

  describe("findExistingAgent", () => {
    const profile: Profile = {
      id: "user-1",
      username: "casey",
      email: "test@example.com",
    };

    it("returns the first agent when one exists", async () => {
      const agent = { id: "agent-1", name: "enc:abcd", owner_id: "user-1" };
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: [agent], error: null }),
        })),
      });

      const result = await findExistingAgent(supabase, profile);
      expect(result).toEqual(agent);
    });

    it("returns null when no agents exist", async () => {
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      });

      const result = await findExistingAgent(supabase, profile);
      expect(result).toBeNull();
    });

    it("throws when agent fetch fails", async () => {
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "DB error" },
          }),
        })),
      });

      await expect(findExistingAgent(supabase, profile)).rejects.toThrow(
        "Failed to fetch agents: DB error"
      );
    });
  });

  describe("promptAgentName", () => {
    it("returns the entered name", async () => {
      mockPromptResponse("my bot");
      const name = await promptAgentName();
      expect(name).toBe("my bot");
    });

    it("throws when the entered name is empty", async () => {
      mockPromptResponse("");
      await expect(promptAgentName()).rejects.toThrow("Agent name is required");
    });
  });

  describe("createAgent", () => {
    const profile: Profile = {
      id: "user-1",
      username: "casey",
      email: "test@example.com",
    };

    it("inserts the row with the supplied (encrypted) name and returns the agent", async () => {
      const newAgent = { id: "agent-new", name: "enc:cipher", owner_id: "user-1" };
      const mockInsertSingle = vi.fn().mockResolvedValue({ data: newAgent, error: null });
      const mockInsertSelect = vi.fn(() => ({ single: mockInsertSingle }));
      const mockInsert = vi.fn(() => ({ select: mockInsertSelect }));
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({ insert: mockInsert });

      const agent = await createAgent(supabase, profile, "enc:cipher");

      expect(mockInsert).toHaveBeenCalledWith({
        owner_id: "user-1",
        name: "enc:cipher",
        model: "unknown",
      });
      expect(agent).toEqual(newAgent);
    });

    it("throws when the insert fails", async () => {
      const mockInsertSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: "DB error" },
      });
      const mockInsertSelect = vi.fn(() => ({ single: mockInsertSingle }));
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({ insert: vi.fn(() => ({ select: mockInsertSelect })) });

      await expect(createAgent(supabase, profile, "enc:cipher")).rejects.toThrow(
        "Failed to create agent: DB error"
      );
    });
  });

  describe("findSpaceForAgent", () => {
    const agent: Agent = { id: "agent-1", name: "enc:xyz", owner_id: "user-1" };

    it("returns the existing space when present", async () => {
      const space = { id: "space-1", agent_id: "agent-1" };
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: [space], error: null }),
        })),
      });

      const result = await findSpaceForAgent(supabase, agent);
      expect(result).toEqual(space);
    });

    it("returns null when the agent has no space yet", async () => {
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      });

      const result = await findSpaceForAgent(supabase, agent);
      expect(result).toBeNull();
    });

    it("throws on DB error", async () => {
      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: null, error: { message: "DB error" } }),
        })),
      });

      await expect(findSpaceForAgent(supabase, agent)).rejects.toThrow(
        "Failed to fetch spaces: DB error"
      );
    });
  });
});
