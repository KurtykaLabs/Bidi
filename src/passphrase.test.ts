import { describe, expect, it } from "vitest";
import { generateRecoveryCode, parseRecoveryCode, validatePassphrase } from "./passphrase.js";

describe("validatePassphrase", () => {
  it("rejects short passphrases", () => {
    const r = validatePassphrase("short");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least 12/);
  });

  it("accepts the minimum length with a warning", () => {
    const r = validatePassphrase("abcdefghijkl"); // 12 chars
    expect(r.ok).toBe(true);
    expect(r.warn).toMatch(/shorter than 16/);
  });

  it("accepts long passphrases with no warning", () => {
    const r = validatePassphrase("correct horse battery staple");
    expect(r.ok).toBe(true);
    expect(r.warn).toBeUndefined();
  });
});

describe("recovery code codec", () => {
  it("rejects wrong-length inputs to the generator", () => {
    expect(() => generateRecoveryCode(new Uint8Array(16))).toThrow(/30 bytes/);
  });

  it("produces 8 groups of 6 chars separated by hyphens", () => {
    const bytes = new Uint8Array(30).fill(0);
    const code = generateRecoveryCode(bytes);
    expect(code.split("-")).toHaveLength(8);
    for (const group of code.split("-")) expect(group.length).toBe(6);
  });

  it("round-trips random bytes", () => {
    for (let i = 0; i < 20; i++) {
      const bytes = new Uint8Array(30);
      for (let j = 0; j < 30; j++) bytes[j] = Math.floor(Math.random() * 256);
      const code = generateRecoveryCode(bytes);
      const recovered = parseRecoveryCode(code);
      expect(Buffer.from(recovered).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("parses back with whitespace and mixed case", () => {
    const bytes = new Uint8Array(30);
    for (let i = 0; i < 30; i++) bytes[i] = i * 7 + 1;
    const code = generateRecoveryCode(bytes);
    const messy = code.toLowerCase().replace(/-/g, "  -  ");
    const recovered = parseRecoveryCode(messy);
    expect(Buffer.from(recovered).equals(Buffer.from(bytes))).toBe(true);
  });

  it("rejects invalid characters", () => {
    expect(() =>
      parseRecoveryCode("IIIIII-IIIIII-IIIIII-IIIIII-IIIIII-IIIIII-IIIIII-IIIIII")
    ).toThrow(/invalid/);
  });

  it("rejects wrong total length", () => {
    expect(() => parseRecoveryCode("AAAAAA-BBBBBB")).toThrow(/48 base32 chars/);
  });

  it("uses the no-IOL01 alphabet", () => {
    const code = generateRecoveryCode(new Uint8Array(30).fill(0xff));
    expect(code).not.toMatch(/[IOL01]/);
  });
});
