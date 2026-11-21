import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { hostDir } from "./scratch.ts";

const absent = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export class JobFiles {
  private readonly unsettled = new Set<number>();

  private readonly token: string;
  private readonly warn: (text: string) => void;

  constructor(token: string, warn: (text: string) => void) {
    this.token = token;
    this.warn = warn;
  }

  remember(job: number, file: string): void {
    mkdirSync(this.ownerDir(), { recursive: true });
    writeFileSync(this.launchRecord(job), file, { mode: 0o600 });
  }

  private owner(job: number): string {
    return createHash("sha256")
      .update(`${this.token}:${String(job)}`)
      .digest("hex")
      .slice(0, 32);
  }

  legacyLaunchName(job: number): string {
    return `fleet-job-${String(job)}-${this.owner(job)}.json`;
  }

  private ownerDir(): string {
    const owner = createHash("sha256").update(this.token).digest("hex").slice(0, 32);
    return join(hostDir(), "job-launch-files", owner);
  }

  private launchRecord(job: number): string {
    return join(this.ownerDir(), `${String(job)}.path`);
  }

  private pendingRecord(job: number): string {
    return join(this.ownerDir(), `${String(job)}.pending`);
  }

  settleLaunchFile(job: number): void {
    try {
      renameSync(this.launchRecord(job), this.pendingRecord(job));
    } catch (error) {
      if (!absent(error)) {
        const why = error instanceof Error ? error.message : String(error);
        this.unsettled.add(job);
        this.warn(`Job ${String(job)}'s launch record could not be marked for removal: ${why}`);
        return;
      }
    }
    this.cleanLaunchFile(job);
  }

  private cleanLaunchFile(job: number): void {
    const marker = this.pendingRecord(job);
    let file: string;
    try {
      file = readFileSync(marker, "utf8").trim();
    } catch (error) {
      if (!absent(error)) {
        const why = error instanceof Error ? error.message : String(error);
        this.warn(`Job ${String(job)}'s launch record ${marker} could not be read: ${why}`);
      }
      return;
    }
    if (!isAbsolute(file) || basename(file) !== this.legacyLaunchName(job)) {
      this.warn(`Job ${String(job)}'s launch record ${marker} does not name its launch file`);
      return;
    }
    if (this.removeFile(job, file)) this.removeFile(job, marker);
  }

  resumeLaunchCleanup(): void {
    for (const job of [...this.unsettled]) {
      this.unsettled.delete(job);
      this.settleLaunchFile(job);
    }
    let names: string[];
    try {
      names = readdirSync(this.ownerDir());
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^(\d+)\.pending$/.exec(name);
      if (match?.[1] !== undefined) this.cleanLaunchFile(Number(match[1]));
    }
  }

  removeFile(job: number, file: string): boolean {
    try {
      rmSync(file, { force: true });
      return true;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.warn(`Job ${String(job)}'s launch file ${file} could not be removed: ${why}`);
      return false;
    }
  }
}
