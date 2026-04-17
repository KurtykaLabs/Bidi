import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildWrappedSeedBlob,
  decryptJsonPayload,
  decryptString,
  deriveKeyFromPassphrase,
  encryptJsonPayload,
  encryptString,
  ensureSodium,
  isEncryptedPayload,
  keypairFromSeed,
  openWrappedSeedBlob,
  randomBytes,
  sealToPublicKey,
  secretboxOpen,
  secretboxSeal,
  unsealWithKeypair,
} from "./crypto.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo");

beforeAll(async () => {
  await ensureSodium();
  await sodium.ready;
});

describe("deriveKeyFromPassphrase", () => {
  it("produces 32 bytes", async () => {
    const salt = await randomBytes(32);
    const key = await deriveKeyFromPassphrase("test passphrase", salt);
    expect(key.length).toBe(32);
  });

  it("is deterministic for same salt + passphrase", async () => {
    const salt = await randomBytes(32);
    const a = await deriveKeyFromPassphrase("same", salt);
    const b = await deriveKeyFromPassphrase("same", salt);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("differs for different salts", async () => {
    const a = await deriveKeyFromPassphrase("pp", await randomBytes(32));
    const b = await deriveKeyFromPassphrase("pp", await randomBytes(32));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("rejects salt of wrong length", async () => {
    await expect(deriveKeyFromPassphrase("pp", await randomBytes(16))).rejects.toThrow(/salt/);
  });
});

describe("secretbox round trip", () => {
  it("encrypts and decrypts", async () => {
    const key = await randomBytes(32);
    const msg = new TextEncoder().encode("hello world");
    const { nonce, ciphertext } = await secretboxSeal(key, msg);
    const decrypted = await secretboxOpen(key, nonce, ciphertext);
    expect(new TextDecoder().decode(decrypted)).toBe("hello world");
  });

  it("fails on wrong key", async () => {
    const key = await randomBytes(32);
    const otherKey = await randomBytes(32);
    const { nonce, ciphertext } = await secretboxSeal(key, new Uint8Array([1, 2, 3]));
    await expect(secretboxOpen(otherKey, nonce, ciphertext)).rejects.toThrow();
  });
});

describe("keypairFromSeed", () => {
  it("is deterministic — same seed produces same keypair", async () => {
    const seed = await randomBytes(32);
    const a = await keypairFromSeed(seed);
    const b = await keypairFromSeed(seed);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
    expect(Buffer.from(a.secretKey).equals(Buffer.from(b.secretKey))).toBe(true);
  });

  it("returns 32-byte pub + 32-byte secret", async () => {
    const kp = await keypairFromSeed(await randomBytes(32));
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });
});

describe("sealed box round trip", () => {
  it("seals and unseals with the same keypair", async () => {
    const kp = await keypairFromSeed(await randomBytes(32));
    const msg = new Uint8Array([9, 8, 7, 6, 5]);
    const sealed = await sealToPublicKey(kp.publicKey, msg);
    const opened = await unsealWithKeypair(sealed, kp.publicKey, kp.secretKey);
    expect(Buffer.from(opened).equals(Buffer.from(msg))).toBe(true);
  });

  it("fails with the wrong keypair", async () => {
    const a = await keypairFromSeed(await randomBytes(32));
    const b = await keypairFromSeed(await randomBytes(32));
    const sealed = await sealToPublicKey(a.publicKey, new Uint8Array([1, 2, 3]));
    await expect(unsealWithKeypair(sealed, b.publicKey, b.secretKey)).rejects.toThrow();
  });

  it("sealed box of 32-byte space key is 80 bytes", async () => {
    const kp = await keypairFromSeed(await randomBytes(32));
    const spaceKey = await randomBytes(32);
    const sealed = await sealToPublicKey(kp.publicKey, spaceKey);
    expect(sealed.length).toBe(80);
  });
});

describe("wrapped-seed blob", () => {
  it("round-trips with the same passphrase", async () => {
    const seed = await randomBytes(32);
    const blob = await buildWrappedSeedBlob(seed, "correct-passphrase");
    const recovered = await openWrappedSeedBlob(blob, "correct-passphrase");
    expect(Buffer.from(recovered).equals(Buffer.from(seed))).toBe(true);
  });

  it("fails with the wrong passphrase", async () => {
    const blob = await buildWrappedSeedBlob(await randomBytes(32), "correct");
    await expect(openWrappedSeedBlob(blob, "wrong")).rejects.toThrow();
  });

  it("rejects a blob with bad version byte", async () => {
    await expect(openWrappedSeedBlob("AAAAAAAA", "pp")).rejects.toThrow(/version|length/);
  });

  it("produces a different blob each time for the same seed + passphrase", async () => {
    const seed = await randomBytes(32);
    const a = await buildWrappedSeedBlob(seed, "pp");
    const b = await buildWrappedSeedBlob(seed, "pp");
    expect(a).not.toBe(b); // salt and nonce differ
  });

  it("matches the whitepaper's 105-byte raw blob layout", async () => {
    const seed = await randomBytes(32);
    const blob = await buildWrappedSeedBlob(seed, "pp");
    const raw = Buffer.from(blob, "base64");
    // v(1) || salt(32) || nonce(24) || ciphertext+tag(48) = 105
    expect(raw.length).toBe(105);
    expect(raw[0]).toBe(0x01);
  });
});

describe("encrypted payload (JSONB string)", () => {
  it("round-trips a nested object", async () => {
    const key = await randomBytes(32);
    const original = { text: "hi", nested: { num: 42, arr: [1, 2, 3] } };
    const encoded = await encryptJsonPayload(key, original);
    expect(typeof encoded).toBe("string");
    const recovered = await decryptJsonPayload(key, encoded);
    expect(recovered).toEqual(original);
  });

  it("emits the unified format with version byte 0x01 at offset 0", async () => {
    const key = await randomBytes(32);
    const encoded = await encryptJsonPayload(key, { text: "hi" });
    const raw = Buffer.from(encoded, "base64");
    expect(raw[0]).toBe(0x01);
    // 1 (version) + 24 (nonce) + 16 (mac) + plaintext length
    expect(raw.length).toBeGreaterThanOrEqual(1 + 24 + 16);
  });

  it("fails with the wrong key", async () => {
    const key = await randomBytes(32);
    const other = await randomBytes(32);
    const encoded = await encryptJsonPayload(key, { text: "hi" });
    await expect(decryptJsonPayload(other, encoded)).rejects.toThrow();
  });

  it("fails on tampered ciphertext", async () => {
    const key = await randomBytes(32);
    const encoded = await encryptJsonPayload(key, { text: "hi" });
    const tampered = encoded.slice(0, -4) + "AAAA";
    await expect(decryptJsonPayload(key, tampered)).rejects.toThrow();
  });
});

describe("isEncryptedPayload", () => {
  it("accepts strings (encrypted JSONB)", () => {
    expect(isEncryptedPayload("AQ==")).toBe(true);
  });

  it("rejects legacy plaintext objects", () => {
    expect(isEncryptedPayload({ text: "hi" })).toBe(false);
    expect(isEncryptedPayload(null)).toBe(false);
    expect(isEncryptedPayload(123)).toBe(false);
    expect(isEncryptedPayload(undefined)).toBe(false);
  });
});

describe("encryptString / decryptString", () => {
  it("round-trips", async () => {
    const key = await randomBytes(32);
    const encrypted = await encryptString(key, "My Agent Name");
    expect(encrypted.startsWith("enc:")).toBe(true);
    const decrypted = await decryptString(key, encrypted);
    expect(decrypted).toBe("My Agent Name");
  });

  it("emits the unified format with version byte 0x01 at offset 0", async () => {
    const key = await randomBytes(32);
    const encrypted = await encryptString(key, "x");
    const body = encrypted.slice("enc:".length);
    // URL-safe base64 (no padding) → decode via Buffer with translation
    const padded = body.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(padded, "base64");
    expect(raw[0]).toBe(0x01);
  });

  it("passes through plaintext (backward compat)", async () => {
    const key = await randomBytes(32);
    expect(await decryptString(key, "Bachman")).toBe("Bachman");
    expect(await decryptString(key, "new_channel")).toBe("new_channel");
  });

  it("fails with the wrong key", async () => {
    const key = await randomBytes(32);
    const other = await randomBytes(32);
    const encrypted = await encryptString(key, "secret");
    await expect(decryptString(other, encrypted)).rejects.toThrow();
  });

  it("handles utf-8 correctly", async () => {
    const key = await randomBytes(32);
    const msg = "naïve café 🔐 ✓";
    expect(await decryptString(key, await encryptString(key, msg))).toBe(msg);
  });
});

describe("cross-platform vectors", () => {
  it("matches the passphrase blob golden vector", async () => {
    const passphrase = "correct horse battery staple";
    const salt = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
    const seed = Uint8Array.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
    const nonce = Uint8Array.from(Array.from({ length: 24 }, (_, i) => 0xc0 + i));
    const expected =
      "AQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fwMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2XLanW+owVADwEDA1XqSzOCBsTOqClKDwC6GpYlpA9sreU4p2o+DXVharaEqKmAn";

    const key = await deriveKeyFromPassphrase(passphrase, salt);
    const ciphertext = sodium.crypto_secretbox_easy(seed, nonce, key);
    const raw = new Uint8Array(1 + salt.length + nonce.length + ciphertext.length);
    raw[0] = 0x01;
    raw.set(salt, 1);
    raw.set(nonce, 1 + salt.length);
    raw.set(ciphertext, 1 + salt.length + nonce.length);

    expect(sodium.to_base64(raw, sodium.base64_variants.ORIGINAL)).toBe(expected);
    const opened = await openWrappedSeedBlob(expected, passphrase);
    expect(Buffer.from(opened).equals(Buffer.from(seed))).toBe(true);
  });

  it("matches the encrypted payload golden vector", async () => {
    const spaceKey = Uint8Array.from(Array.from({ length: 32 }, (_, i) => 0x55 + i));
    const nonce = Uint8Array.from(Array.from({ length: 24 }, (_, i) => 0x80 + i));
    const payloadText = JSON.stringify({ text: "Hello from vector", nested: { n: 7 } });
    const expected =
      "AYCBgoOEhYaHiImKi4yNjo+QkZKTlJWWl9PPv/Sn75LnApRVOoZdA5g13HlCYujzKqNawAWZXwwzsjfmw9kYv6tfZiFnTZjAmXFmDW+8P1TfFGesRw0=";

    const ciphertext = sodium.crypto_secretbox_easy(new TextEncoder().encode(payloadText), nonce, spaceKey);
    const raw = new Uint8Array(1 + nonce.length + ciphertext.length);
    raw[0] = 0x01;
    raw.set(nonce, 1);
    raw.set(ciphertext, 1 + nonce.length);

    expect(sodium.to_base64(raw, sodium.base64_variants.ORIGINAL)).toBe(expected);
    await expect(decryptJsonPayload(spaceKey, expected)).resolves.toEqual({
      text: "Hello from vector",
      nested: { n: 7 },
    });
  });
});
