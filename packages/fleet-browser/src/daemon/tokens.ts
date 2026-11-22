import { timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIN_LENGTH = 32;
const CACHE_MS = 2000;

export class TokenStore {
  private readonly dir: string;
  private loadedAt = 0;
  private tokens: Buffer[] = [];

  constructor(dir: string) {
    this.dir = dir;
    this.load();
    if (this.tokens.length === 0)
      throw new Error(
        `no stream tokens in ${dir}; the stream api needs at least one *.token file of ${MIN_LENGTH}+ characters`,
      );
  }

  matches(header: string | undefined): boolean {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    if (Date.now() - this.loadedAt > CACHE_MS) this.load();
    const given = Buffer.from(header.slice(7));
    let ok = false;
    for (const token of this.tokens) {
      if (given.length === token.length && timingSafeEqual(given, token)) ok = true;
    }
    return ok;
  }

  private load(): void {
    const tokens: Buffer[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".token")) continue;
      const value = readFileSync(join(this.dir, name), "utf8").trim();
      if (value.length >= MIN_LENGTH) tokens.push(Buffer.from(value));
    }
    this.tokens = tokens;
    this.loadedAt = Date.now();
  }
}
