import { createRequire } from "node:module";
import type sodiumType from "libsodium-wrappers-sumo";

// libsodium-wrappers(-sumo) ships a broken ESM entry (references a sibling file
// that isn't published), so we load the CJS build via createRequire.
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as typeof sodiumType;

// Whitepaper Argon2id params: 65536 KiB memory, 3 iterations, 32-byte output,
// 32-byte salt. libsodium's crypto_pwhash hard-codes salt length to 16, so the
// blob holds 32 random bytes (matching the whitepaper wire format) and we
// deterministically compress to 16 via crypto_generichash before feeding Argon2id.
const ARGON2ID_OPSLIMIT = 3;
const ARGON2ID_MEMLIMIT = 65536 * 1024;
const KEY_BYTES = 32;
const WRAPPED_SEED_VERSION = 0x01;
const WRAPPED_SEED_SALT_BYTES = 32;
const CONTENT_VERSION = 0x01;

let readyPromise: Promise<void> | null = null;
export async function ensureSodium(): Promise<typeof sodium> {
  if (!readyPromise) readyPromise = sodium.ready;
  await readyPromise;
  return sodium;
}

/**
 * Thrown when an authenticated decryption fails — wrong key, tampered
 * ciphertext, or wrong passphrase / recovery code. Distinguishable from
 * infrastructure errors (DB outages, network failures) so callers can decide
 * whether to retry the user (DecryptionError) or fail loudly (everything else).
 */
export class DecryptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DecryptionError";
  }
}

export async function randomBytes(n: number): Promise<Uint8Array> {
  const s = await ensureSodium();
  return s.randombytes_buf(n);
}

export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const s = await ensureSodium();
  if (salt.length !== WRAPPED_SEED_SALT_BYTES) {
    throw new Error(`salt must be ${WRAPPED_SEED_SALT_BYTES} bytes`);
  }
  const compressed = s.crypto_generichash(s.crypto_pwhash_SALTBYTES, salt);
  return s.crypto_pwhash(
    KEY_BYTES,
    passphrase,
    compressed,
    ARGON2ID_OPSLIMIT,
    ARGON2ID_MEMLIMIT,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function secretboxSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const s = await ensureSodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ciphertext = s.crypto_secretbox_easy(plaintext, nonce, key);
  return { nonce, ciphertext };
}

export async function secretboxOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const s = await ensureSodium();
  return s.crypto_secretbox_open_easy(ciphertext, nonce, key);
}

export interface Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function keypairFromSeed(seed: Uint8Array): Promise<Keypair> {
  const s = await ensureSodium();
  const kp = s.crypto_box_seed_keypair(seed);
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export async function sealToPublicKey(
  recipientPubKey: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const s = await ensureSodium();
  return s.crypto_box_seal(message, recipientPubKey);
}

export async function unsealWithKeypair(
  ciphertext: Uint8Array,
  publicKey: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  const s = await ensureSodium();
  return s.crypto_box_seal_open(ciphertext, publicKey, secretKey);
}

export function wipe(buf: Uint8Array): void {
  sodium.memzero(buf);
}

// Wrapped-seed blob: v(1) || salt(32) || nonce(24) || ciphertext+tag(48) = 105 bytes.
export async function buildWrappedSeedBlob(
  seed: Uint8Array,
  passphraseOrCode: string,
): Promise<string> {
  const s = await ensureSodium();
  const salt = s.randombytes_buf(WRAPPED_SEED_SALT_BYTES);
  const key = await deriveKeyFromPassphrase(passphraseOrCode, salt);
  try {
    const { nonce, ciphertext } = await secretboxSeal(key, seed);
    const blob = new Uint8Array(1 + salt.length + nonce.length + ciphertext.length);
    blob[0] = WRAPPED_SEED_VERSION;
    blob.set(salt, 1);
    blob.set(nonce, 1 + salt.length);
    blob.set(ciphertext, 1 + salt.length + nonce.length);
    return s.to_base64(blob, s.base64_variants.ORIGINAL);
  } finally {
    wipe(key);
  }
}

export async function openWrappedSeedBlob(
  blob: string,
  passphraseOrCode: string,
): Promise<Uint8Array> {
  const s = await ensureSodium();
  const raw = s.from_base64(blob, s.base64_variants.ORIGINAL);
  if (raw.length < 1 || raw[0] !== WRAPPED_SEED_VERSION) {
    throw new Error("unsupported wrapped-seed version");
  }
  const nonceBytes = s.crypto_secretbox_NONCEBYTES;
  const expected = 1 + WRAPPED_SEED_SALT_BYTES + nonceBytes + KEY_BYTES + s.crypto_secretbox_MACBYTES;
  if (raw.length !== expected) {
    throw new Error(`wrapped-seed blob has wrong length: ${raw.length} (expected ${expected})`);
  }
  const salt = raw.slice(1, 1 + WRAPPED_SEED_SALT_BYTES);
  const nonce = raw.slice(1 + WRAPPED_SEED_SALT_BYTES, 1 + WRAPPED_SEED_SALT_BYTES + nonceBytes);
  const ciphertext = raw.slice(1 + WRAPPED_SEED_SALT_BYTES + nonceBytes);
  const key = await deriveKeyFromPassphrase(passphraseOrCode, salt);
  try {
    return await secretboxOpen(key, nonce, ciphertext);
  } catch (err) {
    throw new DecryptionError("wrong passphrase or recovery code", err);
  } finally {
    wipe(key);
  }
}

// Whitepaper unified content format: base64(version || nonce || ciphertext).
// Used for agent names, channel names (with "enc:" prefix on top), and event
// payloads (raw base64, stored as a JSONB string).
async function packContent(spaceKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const { nonce, ciphertext } = await secretboxSeal(spaceKey, plaintext);
  const out = new Uint8Array(1 + nonce.length + ciphertext.length);
  out[0] = CONTENT_VERSION;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + nonce.length);
  return out;
}

async function unpackContent(spaceKey: Uint8Array, raw: Uint8Array): Promise<Uint8Array> {
  const s = await ensureSodium();
  if (raw.length < 1 || raw[0] !== CONTENT_VERSION) {
    throw new Error("unsupported content version");
  }
  const nonceBytes = s.crypto_secretbox_NONCEBYTES;
  if (raw.length < 1 + nonceBytes + s.crypto_secretbox_MACBYTES) {
    throw new Error("encrypted content too short");
  }
  const nonce = raw.slice(1, 1 + nonceBytes);
  const ciphertext = raw.slice(1 + nonceBytes);
  return secretboxOpen(spaceKey, nonce, ciphertext);
}

// events.payload is JSONB; encrypted form is a JSON string holding base64.
// Plaintext (legacy) form is a JSON object — type alone disambiguates on read.
export type EncryptedPayload = string;

export function isEncryptedPayload(payload: unknown): payload is EncryptedPayload {
  return typeof payload === "string";
}

export async function encryptJsonPayload(
  spaceKey: Uint8Array,
  payload: Record<string, unknown>,
): Promise<EncryptedPayload> {
  const s = await ensureSodium();
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const packed = await packContent(spaceKey, plaintext);
  return s.to_base64(packed, s.base64_variants.ORIGINAL);
}

export async function decryptJsonPayload(
  spaceKey: Uint8Array,
  encoded: EncryptedPayload,
): Promise<Record<string, unknown>> {
  const s = await ensureSodium();
  const raw = s.from_base64(encoded, s.base64_variants.ORIGINAL);
  const plaintext = await unpackContent(spaceKey, raw);
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

const ENC_PREFIX = "enc:";

export async function encryptString(
  spaceKey: Uint8Array,
  plaintext: string,
): Promise<string> {
  const s = await ensureSodium();
  const packed = await packContent(spaceKey, new TextEncoder().encode(plaintext));
  return ENC_PREFIX + s.to_base64(packed, s.base64_variants.URLSAFE_NO_PADDING);
}

export async function decryptString(spaceKey: Uint8Array, value: string): Promise<string> {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const s = await ensureSodium();
  const raw = s.from_base64(value.slice(ENC_PREFIX.length), s.base64_variants.URLSAFE_NO_PADDING);
  const plaintext = await unpackContent(spaceKey, raw);
  return new TextDecoder().decode(plaintext);
}
