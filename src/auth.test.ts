import { describe, it, expect, vi, beforeEach } from "vitest";

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
  ensureAgentAndSpace,
  type Profile,
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

  describe("ensureAgentAndSpace", () => {
    const profile: Profile = {
      id: "user-1",
      username: "casey",
      email: "test@example.com",
    };

    function setupMockFrom(supabase: any, responses: Record<string, any>) {
      supabase.from.mockImplementation((table: string) => {
        if (responses[table]) return responses[table];
        return { select: vi.fn(() => ({ eq: vi.fn() })) };
      });
    }

    it("returns existing agent and space", async () => {
      const agent = { id: "agent-1", name: "casey's agent", owner_id: "user-1" };
      const space = { id: "space-1", agent_id: "agent-1" };

      const supabase = createMockSupabase();
      let fromCallCount = 0;
      supabase.from.mockImplementation(() => {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: [agent], error: null }),
            })),
          };
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ data: [space], error: null }),
          })),
        };
      });

      const result = await ensureAgentAndSpace(supabase, profile);

      expect(result.agent).toEqual(agent);
      expect(result.space).toEqual(space);
    });

    it("creates agent when none exists, prompting for name", async () => {
      const newAgent = { id: "agent-new", name: "my bot", owner_id: "user-1" };
      const space = { id: "space-1", agent_id: "agent-new" };

      mockPromptResponse("my bot");

      const mockInsertSingle = vi.fn().mockResolvedValue({
        data: newAgent,
        error: null,
      });
      const mockInsertSelect = vi.fn(() => ({ single: mockInsertSingle }));

      const supabase = createMockSupabase();
      let fromCallCount = 0;
      supabase.from.mockImplementation(() => {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          };
        }
        if (fromCallCount === 2) {
          return {
            insert: vi.fn(() => ({ select: mockInsertSelect })),
          };
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ data: [space], error: null }),
          })),
        };
      });

      const result = await ensureAgentAndSpace(supabase, profile);

      expect(result.agent).toEqual(newAgent);
    });

    it("creates space via RPC when none exists", async () => {
      const agent = { id: "agent-1", name: "casey's agent", owner_id: "user-1" };
      const newSpace = { id: "space-new", agent_id: "agent-1" };

      const supabase = createMockSupabase();
      supabase.rpc.mockResolvedValue({ data: "space-new", error: null });

      let fromCallCount = 0;
      supabase.from.mockImplementation(() => {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: [agent], error: null }),
            })),
          };
        }
        if (fromCallCount === 2) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          };
        }
        // fetch new space after RPC
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: newSpace, error: null }),
            })),
          })),
        };
      });

      const result = await ensureAgentAndSpace(supabase, profile);

      expect(supabase.rpc).toHaveBeenCalledWith("create_space", {
        p_agent_id: "agent-1",
      });
      expect(result.space).toEqual(newSpace);
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

      await expect(ensureAgentAndSpace(supabase, profile)).rejects.toThrow(
        "Failed to fetch agents: DB error"
      );
    });

    it("throws when space creation RPC fails", async () => {
      const agent = { id: "agent-1", name: "casey's agent", owner_id: "user-1" };

      const supabase = createMockSupabase();
      supabase.rpc.mockResolvedValue({
        data: null,
        error: { message: "Not the agent owner" },
      });

      let fromCallCount = 0;
      supabase.from.mockImplementation(() => {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: [agent], error: null }),
            })),
          };
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
        };
      });

      await expect(ensureAgentAndSpace(supabase, profile)).rejects.toThrow(
        "Failed to create space: Not the agent owner"
      );
    });

    it("throws when agent name is empty", async () => {
      mockPromptResponse("");

      const supabase = createMockSupabase();
      supabase.from.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      });

      await expect(ensureAgentAndSpace(supabase, profile)).rejects.toThrow(
        "Agent name is required"
      );
    });
  });
});
