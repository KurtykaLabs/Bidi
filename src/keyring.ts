import type { SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildWrappedSeedBlob,
  DecryptionError,
  ensureSodium,
  type Keypair,
  keypairFromSeed,
  openWrappedSeedBlob,
  randomBytes,
  sealToPublicKey,
  unsealWithKeypair,
  wipe,
} from "./crypto.js";
import {
  createProfileKeys,
  fetchProfileKeys,
  fetchWrappedKey,
  type ProfileKeys,
  updatePassphraseBlob,
  updateWrappedKey,
} from "./db.js";
import {
  generateRecoveryCode,
  promptExistingPassphrase,
  promptNewPassphrase,
  promptRecoveryCode,
} from "./passphrase.js";

const BIDI_DIR = join(homedir(), ".bidi");
const SPACES_DIR = join(BIDI_DIR, "spaces");
const RECOVERY_CODE_FILE = join(BIDI_DIR, "recovery_code.txt");
const CACHE_VERSION = 1;

function spaceKeyPath(spaceId: string): string {
  // Defensive: spaceId is a UUID under our schema, but we never embed user
  // input in a filesystem path without sanitizing.
  if (!/^[a-zA-Z0-9_-]+$/.test(spaceId)) {
    throw new Error(`invalid spaceId for cache path: ${spaceId}`);
  }
  return join(SPACES_DIR, `${spaceId}.json`);
}

export interface KeyringState {
  spaceId: string;
  spaceKey: Uint8Array;
}

export interface AcquireBootDeps {
  promptPassphrase: () => Promise<string>;
  askRetryOrRecover: (remaining: number) => Promise<"retry" | "recover" | "abort">;
  onWrongPassphrase?: (err: DecryptionError, remaining: number) => void;
  onWrongRecoveryCode?: (err: DecryptionError, remaining: number) => void;
  maxAttempts?: number;
  maxRecoveryAttempts?: number;
}

interface SpaceKeyCache {
  version: number;
  spaceId: string;
  spaceKey: string;
  createdAt: string;
}

export function readSpaceKeyCache(spaceId: string): SpaceKeyCache | null {
  const path = spaceKeyPath(spaceId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as SpaceKeyCache;
    if (raw.version !== CACHE_VERSION) return null;
    if (typeof raw.spaceId !== "string" || typeof raw.spaceKey !== "string") return null;
    if (raw.spaceId !== spaceId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeSpaceKeyCache(spaceId: string, spaceKey: Uint8Array): void {
  if (spaceKey.length !== 32) throw new Error("space key must be 32 bytes");
  if (!existsSync(BIDI_DIR)) mkdirSync(BIDI_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(SPACES_DIR)) mkdirSync(SPACES_DIR, { recursive: true, mode: 0o700 });
  const payload: SpaceKeyCache = {
    version: CACHE_VERSION,
    spaceId,
    spaceKey: Buffer.from(spaceKey).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(spaceKeyPath(spaceId), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function deleteSpaceKeyCache(spaceId: string): void {
  const path = spaceKeyPath(spaceId);
  if (existsSync(path)) rmSync(path);
}

export function writeRecoveryCodeFile(code: string): string {
  if (!existsSync(BIDI_DIR)) mkdirSync(BIDI_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(RECOVERY_CODE_FILE, code + "\n", { mode: 0o600 });
  return RECOVERY_CODE_FILE;
}

function decodeSpaceKey(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) throw new Error(`cached space key has wrong length: ${buf.length}`);
  return new Uint8Array(buf);
}

export class Keyring {
  private state: KeyringState | null = null;

  /** Test-only: inject a known space key. Never call this from production code. */
  setForTesting(state: KeyringState): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("setForTesting is test-only");
    }
    this.state = state;
  }

  getSpaceKey(): Uint8Array {
    if (!this.state) throw new Error("keyring not initialized");
    return this.state.spaceKey;
  }

  get spaceId(): string {
    if (!this.state) throw new Error("keyring not initialized");
    return this.state.spaceId;
  }

  async bootstrapProfileKeys(
    supabase: SupabaseClient,
    profile: { id: string }
  ): Promise<Keypair> {
    await ensureSodium();
    console.log(
      "\nFirst-time setup: create a passphrase to protect your messages.\n" +
        "You'll also get a recovery code — save it somewhere safe.\n"
    );
    const passphrase = await promptNewPassphrase();
    const seed = await randomBytes(32);
    try {
      const passphrase_blob = await buildWrappedSeedBlob(seed, passphrase);

      const recoveryBytes = await randomBytes(30);
      const recoveryCode = generateRecoveryCode(recoveryBytes);
      const recovery_blob = await buildWrappedSeedBlob(seed, recoveryCode);

      const keypair = await keypairFromSeed(seed);
      const public_key = Buffer.from(keypair.publicKey).toString("base64");

      await createProfileKeys(supabase, profile.id, {
        public_key,
        passphrase_blob,
        recovery_blob,
      });

      // Write to a 0600 file as the canonical copy (so the user can grab it
      // without relying on terminal scrollback) and also print to stdout for
      // immediate visibility.
      const filePath = writeRecoveryCodeFile(recoveryCode);
      console.log("\n=========================================");
      console.log("YOUR RECOVERY CODE (save this NOW):");
      console.log(`  ${recoveryCode}`);
      console.log(`Also written to: ${filePath} (0600)`);
      console.log("This is the only way to recover your data if you");
      console.log("forget your passphrase. It will NOT be shown again.");
      console.log("Move it somewhere safe and delete the file when done.");
      console.log("=========================================\n");

      return keypair;
    } finally {
      wipe(seed);
    }
  }

  /**
   * Generate a fresh 32-byte space key in memory without persisting it. Used
   * when the caller needs the key before commit (e.g. to encrypt the agent
   * name into the agent row, then commit the matching space). Caller must wipe
   * the returned buffer if commitSpace is not subsequently called.
   */
  async generateSpaceKey(): Promise<Uint8Array> {
    return await randomBytes(32);
  }

  /**
   * Seal an in-memory space key to the owner's public key, register the space
   * via create_space, cache the key, and adopt it as keyring state. Pair with
   * generateSpaceKey to control the moment of generation.
   */
  async commitSpace(
    supabase: SupabaseClient,
    agent: { id: string },
    keypair: Keypair,
    spaceKey: Uint8Array,
  ): Promise<{ spaceId: string; state: KeyringState }> {
    const sealed = await sealToPublicKey(keypair.publicKey, spaceKey);
    const wrappedKey = Buffer.from(sealed).toString("base64");

    const { data: spaceId, error } = await supabase.rpc("create_space", {
      p_agent_id: agent.id,
      p_wrapped_key: wrappedKey,
    });
    if (error) throw new Error(`create_space failed: ${error.message}`);
    if (typeof spaceId !== "string") throw new Error("create_space returned no space id");

    const state: KeyringState = { spaceId, spaceKey };
    this.state = state;
    writeSpaceKeyCache(spaceId, spaceKey);
    return { spaceId, state };
  }

  async bootstrapSpaceAndKey(
    supabase: SupabaseClient,
    agent: { id: string },
    keypair: Keypair
  ): Promise<{ spaceId: string; state: KeyringState }> {
    const spaceKey = await this.generateSpaceKey();
    let committed = false;
    try {
      const result = await this.commitSpace(supabase, agent, keypair, spaceKey);
      committed = true;
      return result;
    } finally {
      if (!committed) wipe(spaceKey);
    }
  }

  /** Read the cached space key for this space. Returns null on miss. */
  loadFromCache(space: { id: string }): KeyringState | null {
    const cache = readSpaceKeyCache(space.id);
    if (!cache) return null;
    try {
      const spaceKey = decodeSpaceKey(cache.spaceKey);
      const state: KeyringState = { spaceId: cache.spaceId, spaceKey };
      this.state = state;
      return state;
    } catch {
      deleteSpaceKeyCache(space.id);
      return null;
    }
  }

  /**
   * Prompt passphrase, unwrap the stored seed, derive the keypair, fetch the
   * member's sealed wrapped_key, unseal, and cache. Throws on wrong passphrase
   * (caller can prompt again or route to recover()).
   */
  async joinExisting(
    supabase: SupabaseClient,
    profile: { id: string },
    space: { id: string },
    passphrase?: string,
    keys?: ProfileKeys
  ): Promise<KeyringState> {
    const profileKeys = keys ?? (await fetchProfileKeys(supabase, profile.id));
    if (!profileKeys.passphrase_blob) {
      throw new Error("profile has no passphrase_blob — did you mean bootstrap?");
    }
    const pp = passphrase ?? (await promptExistingPassphrase());
    const seed = await openWrappedSeedBlob(profileKeys.passphrase_blob, pp);
    try {
      return await this.materializeFromSeed(supabase, profile, space, seed);
    } finally {
      wipe(seed);
    }
  }

  /** Forgotten-passphrase path. Re-wraps seed with new passphrase, then joins. */
  async recover(
    supabase: SupabaseClient,
    profile: { id: string },
    space: { id: string },
    keys?: ProfileKeys
  ): Promise<KeyringState> {
    const profileKeys = keys ?? (await fetchProfileKeys(supabase, profile.id));
    if (!profileKeys.recovery_blob) {
      throw new Error("no recovery blob on file");
    }
    const code = await promptRecoveryCode();
    const seed = await openWrappedSeedBlob(profileKeys.recovery_blob, code);
    try {
      const newPassphrase = await promptNewPassphrase("Choose a new passphrase");
      const newPassphraseBlob = await buildWrappedSeedBlob(seed, newPassphrase);
      await updatePassphraseBlob(supabase, profile.id, newPassphraseBlob);
      return await this.materializeFromSeed(supabase, profile, space, seed);
    } finally {
      wipe(seed);
    }
  }

  /** Derive the Curve25519 keypair from the stored wrapped seed. */
  async deriveKeypair(
    supabase: SupabaseClient,
    profile: { id: string },
    keys?: ProfileKeys
  ): Promise<Keypair> {
    const profileKeys = keys ?? (await fetchProfileKeys(supabase, profile.id));
    if (!profileKeys.passphrase_blob) {
      throw new Error("profile has no passphrase_blob");
    }
    const pp = await promptExistingPassphrase();
    const seed = await openWrappedSeedBlob(profileKeys.passphrase_blob, pp);
    try {
      return await keypairFromSeed(seed);
    } finally {
      wipe(seed);
    }
  }

  /**
   * Boot-time space acquisition: try cache, then loop on passphrase prompts,
   * with a recover-with-code escape hatch. Pure DB/network errors propagate
   * immediately (no spurious re-prompts). Decryption errors trigger the loop.
   *
   * Prompt callbacks are injectable so tests can drive the flow without TTY.
   */
  async acquireAtBoot(
    supabase: SupabaseClient,
    profile: { id: string },
    space: { id: string },
    profileKeys: ProfileKeys,
    deps: AcquireBootDeps,
  ): Promise<KeyringState> {
    const cached = this.loadFromCache(space);
    if (cached) return cached;

    const maxAttempts = deps.maxAttempts ?? 3;
    let lastDecryptionError: DecryptionError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const passphrase = await deps.promptPassphrase();
        return await this.joinExisting(supabase, profile, space, passphrase, profileKeys);
      } catch (err) {
        if (!(err instanceof DecryptionError)) throw err;
        lastDecryptionError = err;
        const remaining = maxAttempts - attempt;
        deps.onWrongPassphrase?.(err, remaining);
        if (remaining === 0) break;
        const choice = await deps.askRetryOrRecover(remaining);
        if (choice === "abort") break;
        if (choice === "recover") {
          return await this.recoverWithRetry(supabase, profile, space, profileKeys, deps);
        }
      }
    }
    throw lastDecryptionError ?? new Error("Could not unlock space");
  }

  private async recoverWithRetry(
    supabase: SupabaseClient,
    profile: { id: string },
    space: { id: string },
    profileKeys: ProfileKeys,
    deps: AcquireBootDeps,
  ): Promise<KeyringState> {
    const maxAttempts = deps.maxRecoveryAttempts ?? 3;
    let lastErr: DecryptionError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.recover(supabase, profile, space, profileKeys);
      } catch (err) {
        if (!(err instanceof DecryptionError)) throw err;
        lastErr = err;
        deps.onWrongRecoveryCode?.(err, maxAttempts - attempt);
        if (attempt === maxAttempts) break;
      }
    }
    throw lastErr ?? new Error("Recovery failed");
  }

  clear(): void {
    if (this.state) {
      const spaceId = this.state.spaceId;
      wipe(this.state.spaceKey);
      this.state = null;
      deleteSpaceKeyCache(spaceId);
    }
  }

  private async materializeFromSeed(
    supabase: SupabaseClient,
    profile: { id: string },
    space: { id: string },
    seed: Uint8Array
  ): Promise<KeyringState> {
    const keypair = await keypairFromSeed(seed);
    try {
      const wrappedKey = await fetchWrappedKey(supabase, space.id, profile.id);
      if (!wrappedKey) {
        // Legacy: space exists from before 013 / before this profile had a
        // keypair. Generate a fresh space key and seal it to own pubkey. Safe
        // only because no encrypted data could have existed before this point —
        // any pre-existing plaintext rows still pass through on read.
        const spaceKey = await randomBytes(32);
        let committed = false;
        try {
          const sealed = await sealToPublicKey(keypair.publicKey, spaceKey);
          await updateWrappedKey(
            supabase,
            space.id,
            profile.id,
            Buffer.from(sealed).toString("base64"),
          );
          const state: KeyringState = { spaceId: space.id, spaceKey };
          this.state = state;
          writeSpaceKeyCache(space.id, spaceKey);
          committed = true;
          return state;
        } finally {
          if (!committed) wipe(spaceKey);
        }
      }
      const sealed = new Uint8Array(Buffer.from(wrappedKey, "base64"));
      const spaceKey = await unsealWithKeypair(sealed, keypair.publicKey, keypair.secretKey);
      const state: KeyringState = { spaceId: space.id, spaceKey };
      this.state = state;
      writeSpaceKeyCache(space.id, spaceKey);
      return state;
    } finally {
      wipe(keypair.secretKey);
    }
  }
}
