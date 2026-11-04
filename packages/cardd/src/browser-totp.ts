import { createHmac } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

function seedOf(field: string): string {
  const fromUri = /secret=([^&]+)/i.exec(field)?.[1];
  return (fromUri ?? field).replace(/[\s=-]/g, "").toUpperCase();
}

function decode(seed: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const letter of seed) {
    const index = ALPHABET.indexOf(letter);
    if (index < 0) throw new Error("the entry's totp field is not a base32 seed");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(field: string, nowMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / STEP_MS)));
  const digest = createHmac("sha1", decode(seedOf(field)))
    .update(counter)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  const part = (index: number): number => digest[offset + index] ?? 0;
  const code = (((part(0) & 0x7f) << 24) | (part(1) << 16) | (part(2) << 8) | part(3)) % 1_000_000;
  return String(code).padStart(6, "0");
}
