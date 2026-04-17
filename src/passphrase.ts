import { createInterface } from "node:readline";
import { Writable } from "node:stream";

const MIN_LENGTH = 12;
const WARN_LENGTH = 16;

// Whitepaper base32 alphabet: 26 letters + 10 digits minus {I, O, 0, 1}.
const BASE32_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Whitepaper §12.1: 30 bytes (240 bits) → 48 base32 chars → 8 groups of 6.
const RECOVERY_BYTES = 30;
const RECOVERY_GROUPS = 8;
const RECOVERY_GROUP_LEN = 6;

function prompt(question: string, muted: boolean): Promise<string> {
  const output = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: muted ? output : process.stdout,
    terminal: true,
  });
  if (!muted) process.stdout.write(question);
  else process.stderr.write(question);
  return new Promise((resolve, reject) => {
    rl.question("", (answer) => {
      rl.close();
      if (muted) process.stderr.write("\n");
      resolve(answer);
    });
    rl.on("error", reject);
  });
}

export async function promptHidden(question: string): Promise<string> {
  return prompt(question, true);
}

export async function promptVisible(question: string): Promise<string> {
  return prompt(question, false);
}

export function validatePassphrase(candidate: string): { ok: boolean; error?: string; warn?: string } {
  if (candidate.length < MIN_LENGTH) {
    return { ok: false, error: `Passphrase must be at least ${MIN_LENGTH} characters.` };
  }
  if (candidate.length < WARN_LENGTH) {
    return { ok: true, warn: `Passphrase is shorter than ${WARN_LENGTH} characters — consider a longer one.` };
  }
  return { ok: true };
}

export async function promptNewPassphrase(label = "Create a passphrase"): Promise<string> {
  while (true) {
    const pp = await promptHidden(`${label}: `);
    const check = validatePassphrase(pp);
    if (!check.ok) {
      process.stderr.write(`${check.error}\n`);
      continue;
    }
    if (check.warn) process.stderr.write(`${check.warn}\n`);
    const confirm = await promptHidden("Confirm passphrase: ");
    if (confirm !== pp) {
      process.stderr.write("Passphrases did not match. Try again.\n");
      continue;
    }
    return pp;
  }
}

export async function promptExistingPassphrase(label = "Enter passphrase"): Promise<string> {
  return promptHidden(`${label}: `);
}

export async function promptRecoveryCode(label = "Enter recovery code"): Promise<string> {
  return promptHidden(`${label}: `);
}

export function generateRecoveryCode(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_BYTES) {
    throw new Error(`recovery code needs ${RECOVERY_BYTES} bytes of entropy`);
  }
  const totalChars = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
  const out: string[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  let byteIdx = 0;
  for (let i = 0; i < totalChars; i++) {
    while (bitCount < 5) {
      bitBuf = (bitBuf << 8) | bytes[byteIdx++];
      bitCount += 8;
    }
    const idx = (bitBuf >> (bitCount - 5)) & 0x1f;
    bitCount -= 5;
    out.push(BASE32_ALPHABET[idx]);
  }
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    groups.push(out.slice(g * RECOVERY_GROUP_LEN, (g + 1) * RECOVERY_GROUP_LEN).join(""));
  }
  return groups.join("-");
}

export function parseRecoveryCode(input: string): Uint8Array {
  const normalized = input.replace(/[\s-]+/g, "").toUpperCase();
  const totalChars = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
  if (normalized.length !== totalChars) {
    throw new Error(`recovery code must be ${totalChars} base32 chars (got ${normalized.length})`);
  }
  const bytes = new Uint8Array(RECOVERY_BYTES);
  let bitBuf = 0;
  let bitCount = 0;
  let byteIdx = 0;
  for (const ch of normalized) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid character in recovery code: ${ch}`);
    bitBuf = (bitBuf << 5) | idx;
    bitCount += 5;
    while (bitCount >= 8 && byteIdx < RECOVERY_BYTES) {
      bitCount -= 8;
      bytes[byteIdx++] = (bitBuf >> bitCount) & 0xff;
    }
  }
  if (byteIdx !== RECOVERY_BYTES) {
    throw new Error(`recovery code did not decode to ${RECOVERY_BYTES} bytes`);
  }
  return bytes;
}
