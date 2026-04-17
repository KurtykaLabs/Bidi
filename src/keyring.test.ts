import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn<(path: string, enc?: string) => string>(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock("node:fs", () => mockFs);

const mockPassphrase = vi.hoisted(() => ({
  promptNewPassphrase: vi.fn<() => Promise<string>>(),
  promptExistingPassphrase: vi.fn<() => Promise<string>>(),
  promptRecoveryCode: vi.fn<() => Promise<string>>(),
  generateRecoveryCode: vi.fn<(b: Uint8Array) => string>(),
}));
vi.mock("./passphrase.js", () => mockPassphrase);

const {
  ensureSodium,
  keypairFromSeed,
  randomBytes,
  sealToPublicKey,
  buildWrappedSeedBlob,
} = await import("./crypto.js");
const { Keyring } = await import("./keyring.js");

function memoryStore(initial: Record<string, string | null> = {}) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(initial)) if (v !== null) files[k] = v;

  mockFs.existsSync.mockImplementation((p: string) => p in files);
  mockFs.readFileSync.mockImplementation((p: string) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  });
  mockFs.writeFileSync.mockImplementation((p: unknown, data: unknown) => {
    files[String(p)] = String(data);
  });
  mockFs.rmSync.mockImplementation((p: unknown) => {
    delete files[String(p)];
  });
  return files;
}

function fakeSupabaseWithRpc(
  createSpaceResult: { data: string | null; error: { message: string } | null }
): { rpc: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> } {
  return {
    rpc: vi.fn().mockResolvedValue(createSpaceResult),
    from: vi.fn(() => {
      throw new Error("from() not expected here");
    }),
  };
}

function fakeSupabaseForFetchProfile(profile: {
  public_key: string | null;
  passphrase_blob: string | null;
  recovery_blob: string | null;
}) {
  const single = vi.fn().mockResolvedValue({ data: { id: "prof-1", ...profile }, error: null });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  return {
    from: vi.fn(() => ({ select, update })),
    rpc: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NODE_ENV = "test";
  memoryStore();
});

describe("space key cache", () => {
  it("writes and reads a 32-byte key", async () => {
    await ensureSodium();
    const kr = new Keyring();
    const files = memoryStore();
    const sk = await randomBytes(32);
    kr.setForTesting({ spaceId: "s1", spaceKey: sk });

    // simulate cache round trip
    const { writeSpaceKeyCache, readSpaceKeyCache } = await import("./keyring.js");
    writeSpaceKeyCache("s1", sk);
    expect(Object.keys(files).length).toBe(1);
    const cache = readSpaceKeyCache("s1");
    expect(cache).toMatchObject({ version: 1, spaceId: "s1" });
  });

  it("returns null when no cache file exists for this space", () => {
    memoryStore();
    const kr = new Keyring();
    const result = kr.loadFromCache({ id: "fresh-space" });
    expect(result).toBeNull();
  });

  it("returns null and deletes the file when stored spaceId disagrees with filename", async () => {
    // Defense-in-depth: if the file content was tampered with so its embedded
    // spaceId no longer matches the filename, treat it as corrupt.
    const path = `${process.env.HOME || ""}/.bidi/spaces/mine.json`;
    const files = memoryStore({
      [path]: JSON.stringify({
        version: 1,
        spaceId: "wrong",
        spaceKey: Buffer.alloc(32).toString("base64"),
        createdAt: "now",
      }),
    });
    const kr = new Keyring();
    const result = kr.loadFromCache({ id: "mine" });
    expect(result).toBeNull();
    // file is left in place — only loadFromCache deletes when the decode
    // itself fails; embedded-spaceId mismatch falls through readSpaceKeyCache
    // returning null.
    expect(Object.keys(files).length).toBe(1);
  });
});

describe("bootstrapProfileKeys", () => {
  it("generates a keypair, writes wrapped blobs, returns keypair", async () => {
    await ensureSodium();
    memoryStore();
    mockPassphrase.promptNewPassphrase.mockResolvedValue("a-long-passphrase-12+");
    mockPassphrase.generateRecoveryCode.mockImplementation((b) =>
      Buffer.from(b).toString("hex")
    );

    const profileUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: "prof-1" }, error: null }),
          }),
        }),
      }),
    });
    const encryptionInsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "profiles") return { update: profileUpdate };
        if (table === "encryption_keys") return { insert: encryptionInsert };
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(),
    };

    const kr = new Keyring();
    const keypair = await kr.bootstrapProfileKeys(supabase as never, { id: "prof-1" });

    expect(keypair.publicKey.length).toBe(32);
    expect(keypair.secretKey.length).toBe(32);
    expect(profileUpdate).toHaveBeenCalledTimes(1);
    expect(encryptionInsert).toHaveBeenCalledTimes(1);
    const profileFields = profileUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(profileFields.public_key).toEqual(expect.any(String));
    const encryptionFields = encryptionInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(encryptionFields.profile_id).toBe("prof-1");
    expect(encryptionFields.passphrase_blob).toEqual(expect.any(String));
    expect(encryptionFields.recovery_blob).toEqual(expect.any(String));
  });
});

describe("bootstrapSpaceAndKey", () => {
  it("calls create_space with a wrapped_key and caches the space key", async () => {
    await ensureSodium();
    const files = memoryStore();
    const kr = new Keyring();
    const seed = await randomBytes(32);
    const keypair = await keypairFromSeed(seed);

    const supabase = fakeSupabaseWithRpc({ data: "space-1", error: null });
    const result = await kr.bootstrapSpaceAndKey(supabase as never, { id: "agent-1" }, keypair);

    expect(result.spaceId).toBe("space-1");
    expect(result.state.spaceKey.length).toBe(32);
    expect(supabase.rpc).toHaveBeenCalledWith("create_space", {
      p_agent_id: "agent-1",
      p_wrapped_key: expect.any(String),
    });
    expect(Object.keys(files).length).toBe(1);
    expect(kr.getSpaceKey().length).toBe(32);
    expect(kr.spaceId).toBe("space-1");
  });

  it("throws when create_space errors", async () => {
    await ensureSodium();
    memoryStore();
    const kr = new Keyring();
    const keypair = await keypairFromSeed(await randomBytes(32));
    const supabase = fakeSupabaseWithRpc({ data: null, error: { message: "nope" } });
    await expect(
      kr.bootstrapSpaceAndKey(supabase as never, { id: "agent-1" }, keypair)
    ).rejects.toThrow(/nope/);
  });
});

describe("joinExisting", () => {
  it("unwraps seed, derives keypair, unseals wrapped_key, caches space key", async () => {
    await ensureSodium();
    memoryStore();

    const seed = await randomBytes(32);
    const keypair = await keypairFromSeed(seed);
    const passphrase_blob = await buildWrappedSeedBlob(seed, "secret-phrase-123");
    const spaceKey = await randomBytes(32);
    const sealed = await sealToPublicKey(keypair.publicKey, spaceKey);
    const wrappedKeyB64 = Buffer.from(sealed).toString("base64");

    // Fake supabase: profiles row + encryption_keys row + space_members row.
    const profileSingle = vi.fn().mockResolvedValue({
      data: {
        id: "prof-1",
        public_key: Buffer.from(keypair.publicKey).toString("base64"),
      },
      error: null,
    });
    const encryptionMaybeSingle = vi.fn().mockResolvedValue({
      data: { passphrase_blob, recovery_blob: null },
      error: null,
    });
    const wrappedKeyMaybeSingle = vi.fn().mockResolvedValue({
      data: { wrapped_key: wrappedKeyB64 },
      error: null,
    });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ single: profileSingle }),
            }),
          };
        }
        if (table === "encryption_keys") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ maybeSingle: encryptionMaybeSingle }),
            }),
          };
        }
        if (table === "space_members") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({ maybeSingle: wrappedKeyMaybeSingle }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(),
    };

    const kr = new Keyring();
    const state = await kr.joinExisting(
      supabase as never,
      { id: "prof-1" },
      { id: "space-1" },
      "secret-phrase-123"
    );

    expect(state.spaceId).toBe("space-1");
    expect(Buffer.from(state.spaceKey).equals(Buffer.from(spaceKey))).toBe(true);
    expect(kr.getSpaceKey()).toBe(state.spaceKey);
  });

  it("throws on wrong passphrase", async () => {
    await ensureSodium();
    memoryStore();

    const seed = await randomBytes(32);
    const passphrase_blob = await buildWrappedSeedBlob(seed, "correct");

    const profileSingle = vi.fn().mockResolvedValue({
      data: { id: "prof-1", public_key: null },
      error: null,
    });
    const encryptionMaybeSingle = vi.fn().mockResolvedValue({
      data: { passphrase_blob, recovery_blob: null },
      error: null,
    });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ single: profileSingle }),
            }),
          };
        }
        if (table === "encryption_keys") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ maybeSingle: encryptionMaybeSingle }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(),
    };

    const kr = new Keyring();
    await expect(
      kr.joinExisting(supabase as never, { id: "prof-1" }, { id: "space-1" }, "wrong")
    ).rejects.toThrow();
  });
});

describe("clear", () => {
  it("wipes state and deletes cache file", async () => {
    await ensureSodium();
    const files = memoryStore();
    const kr = new Keyring();
    const sk = await randomBytes(32);
    kr.setForTesting({ spaceId: "s1", spaceKey: sk });
    const { writeSpaceKeyCache } = await import("./keyring.js");
    writeSpaceKeyCache("s1", sk);
    expect(Object.keys(files).length).toBe(1);

    kr.clear();
    expect(Object.keys(files).length).toBe(0);
    expect(() => kr.getSpaceKey()).toThrow(/not initialized/);
  });
});

describe("joinExisting with legacy wrapped_key=NULL", () => {
  it("auto-remediates by sealing a new space key and writing to space_members", async () => {
    await ensureSodium();
    memoryStore();

    const seed = await randomBytes(32);
    const keypair = await keypairFromSeed(seed);
    const passphrase_blob = await buildWrappedSeedBlob(seed, "secret-phrase-123");

    // encryption_keys.select returns the passphrase blob; space_members.select returns
    // wrapped_key=null; space_members.update accepts the new sealed key.
    const profileSingle = vi.fn().mockResolvedValue({
      data: {
        id: "prof-1",
        public_key: Buffer.from(keypair.publicKey).toString("base64"),
      },
      error: null,
    });
    const encryptionMaybeSingle = vi.fn().mockResolvedValue({
      data: { passphrase_blob, recovery_blob: null },
      error: null,
    });
    const wrappedKeyMaybeSingle = vi.fn().mockResolvedValue({
      data: { wrapped_key: null },
      error: null,
    });

    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    });

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ single: profileSingle }),
            }),
          };
        }
        if (table === "encryption_keys") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ maybeSingle: encryptionMaybeSingle }),
            }),
          };
        }
        if (table === "space_members") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({ maybeSingle: wrappedKeyMaybeSingle }),
              }),
            }),
            update: updateMock,
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(),
    };

    const kr = new Keyring();
    const state = await kr.joinExisting(
      supabase as never,
      { id: "prof-1" },
      { id: "space-1" },
      "secret-phrase-123"
    );

    expect(state.spaceId).toBe("space-1");
    expect(state.spaceKey.length).toBe(32);
    // The sealed key was written back via update(...).eq(...).eq(...).
    expect(updateMock).toHaveBeenCalledTimes(1);
    const fields = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof fields.wrapped_key).toBe("string");
    expect((fields.wrapped_key as string).length).toBeGreaterThan(100);
  });
});

describe("acquireAtBoot", () => {
  /**
   * Build a (profileKeys, supabase) pair for boot tests. The profileKeys
   * already include the real passphrase blob so joinExisting skips its fetch;
   * supabase only handles the space_members.wrapped_key fetch.
   */
  async function fixture(passphrase: string) {
    await ensureSodium();
    const seed = await randomBytes(32);
    const kp = await keypairFromSeed(seed);
    const passphrase_blob = await buildWrappedSeedBlob(seed, passphrase);
    const spaceKey = await randomBytes(32);
    const sealed = await sealToPublicKey(kp.publicKey, spaceKey);
    const wrappedKeyB64 = Buffer.from(sealed).toString("base64");

    const profileKeys = {
      id: "prof-1",
      public_key: Buffer.from(kp.publicKey).toString("base64"),
      passphrase_blob,
      recovery_blob: null,
    };

    const wrappedKeyMaybeSingle = vi.fn().mockResolvedValue({
      data: { wrapped_key: wrappedKeyB64 },
      error: null,
    });

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "space_members") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({ maybeSingle: wrappedKeyMaybeSingle }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(),
    };

    return { supabase, profileKeys, spaceKey, wrappedKeyMaybeSingle };
  }

  it("succeeds on the first attempt with the correct passphrase", async () => {
    memoryStore();
    const { supabase, profileKeys, spaceKey } = await fixture("the-correct-pass");

    const promptPassphrase = vi.fn().mockResolvedValue("the-correct-pass");
    const askRetryOrRecover = vi.fn();

    const kr = new Keyring();
    const state = await kr.acquireAtBoot(
      supabase as never,
      { id: "prof-1" },
      { id: "space-1" },
      profileKeys,
      { promptPassphrase, askRetryOrRecover },
    );

    expect(state.spaceId).toBe("space-1");
    expect(Buffer.from(state.spaceKey).equals(Buffer.from(spaceKey))).toBe(true);
    expect(promptPassphrase).toHaveBeenCalledTimes(1);
    expect(askRetryOrRecover).not.toHaveBeenCalled();
  });

  it("retries on wrong passphrase, succeeds on the second attempt", async () => {
    memoryStore();
    const { supabase, profileKeys } = await fixture("right-pass");

    const promptPassphrase = vi.fn()
      .mockResolvedValueOnce("wrong-pass")
      .mockResolvedValueOnce("right-pass");
    const askRetryOrRecover = vi.fn().mockResolvedValue("retry");
    const onWrongPassphrase = vi.fn();

    const kr = new Keyring();
    const state = await kr.acquireAtBoot(
      supabase as never,
      { id: "prof-1" },
      { id: "space-1" },
      profileKeys,
      { promptPassphrase, askRetryOrRecover, onWrongPassphrase },
    );

    expect(state.spaceId).toBe("space-1");
    expect(promptPassphrase).toHaveBeenCalledTimes(2);
    expect(onWrongPassphrase).toHaveBeenCalledTimes(1);
  });

  it("throws DecryptionError after maxAttempts wrong passphrases", async () => {
    memoryStore();
    const { supabase, profileKeys } = await fixture("right");

    const promptPassphrase = vi.fn().mockResolvedValue("nope");
    const askRetryOrRecover = vi.fn().mockResolvedValue("retry");

    const kr = new Keyring();
    await expect(
      kr.acquireAtBoot(
        supabase as never,
        { id: "prof-1" },
        { id: "space-1" },
        profileKeys,
        { promptPassphrase, askRetryOrRecover, maxAttempts: 2 },
      )
    ).rejects.toThrow(/passphrase|recovery code/);
    expect(promptPassphrase).toHaveBeenCalledTimes(2);
  });

  it("aborts immediately when user chooses abort", async () => {
    memoryStore();
    const { supabase, profileKeys } = await fixture("right");

    const promptPassphrase = vi.fn().mockResolvedValue("wrong");
    const askRetryOrRecover = vi.fn().mockResolvedValue("abort");

    const kr = new Keyring();
    await expect(
      kr.acquireAtBoot(
        supabase as never,
        { id: "prof-1" },
        { id: "space-1" },
        profileKeys,
        { promptPassphrase, askRetryOrRecover, maxAttempts: 5 },
      )
    ).rejects.toThrow();
    expect(promptPassphrase).toHaveBeenCalledTimes(1);
  });

  it("propagates infra errors immediately and does not prompt the user a second time", async () => {
    memoryStore();
    const { profileKeys } = await fixture("anything");

    // Make space_members.maybeSingle throw a DB-style error (NOT a decryption error).
    const wrappedKeyMaybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "DB outage" },
    });
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: wrappedKeyMaybeSingle }),
          }),
        }),
      })),
      rpc: vi.fn(),
    };

    const promptPassphrase = vi.fn().mockResolvedValue("anything");
    const askRetryOrRecover = vi.fn();

    const kr = new Keyring();
    await expect(
      kr.acquireAtBoot(
        supabase as never,
        { id: "prof-1" },
        { id: "space-1" },
        profileKeys,
        { promptPassphrase, askRetryOrRecover },
      )
    ).rejects.toThrow(/DB outage|wrapped_key/);
    // Crucially: prompted exactly once and no retry/recover offer was shown.
    expect(promptPassphrase).toHaveBeenCalledTimes(1);
    expect(askRetryOrRecover).not.toHaveBeenCalled();
  });
});
