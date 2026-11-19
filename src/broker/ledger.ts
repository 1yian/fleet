import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY_MS = 24 * 3600 * 1000;

export class ReadLedger {
  private readonly path: string;
  private reads: number[];

  constructor(stateDir: string) {
    this.path = join(stateDir, "reads.json");
    this.reads = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as number[]) : [];
    this.prune();
  }

  used(): number {
    this.prune();
    return this.reads.length;
  }

  record(count: number): void {
    const now = Date.now();
    for (let i = 0; i < count; i += 1) this.reads.push(now);
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.reads), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  private prune(): void {
    const cutoff = Date.now() - DAY_MS;
    this.reads = this.reads.filter((at) => at > cutoff);
  }
}
