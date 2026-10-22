import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord, publishRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";

const FAKE = fileURLToPath(new URL("./fake-gh.ts", import.meta.url));

type Bucket = "pass" | "fail" | "pending";

export class FakeGitHub {
  private readonly dir = tempDir("fleet-gh-");
  private readonly file = join(this.dir, "prs.json");

  constructor() {
    publishRecord(this.file, {});
    const shim = join(this.dir, "gh");
    writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(FAKE)} "$@"\n`);
    chmodSync(shim, 0o755);
  }

  get env(): Record<string, string> {
    return { PATH: `${this.dir}:${process.env["PATH"] ?? ""}`, FAKE_GH_STATE: this.file };
  }

  setPr(
    url: string,
    state: "OPEN" | "MERGED" | "CLOSED",
    checks: Record<string, Bucket> = {},
  ): void {
    const all = parseRecord(readFileSync(this.file, "utf8"));
    const list = Object.entries(checks).map(([name, bucket]) => ({ name, bucket }));
    const kept = all[url];
    const head: unknown =
      typeof kept === "object" && kept !== null ? Reflect.get(kept, "head") : undefined;
    const pr = { state, checks: list, ...(head === undefined ? {} : { head }) };
    publishRecord(this.file, { ...all, [url]: pr });
  }

  slow(ms: number): void {
    const all = parseRecord(readFileSync(this.file, "utf8"));
    publishRecord(this.file, { ...all, $delay: ms });
  }

  callsInFlight(): { started: number; now: number; most: number; pids: number[] } {
    const log = `${this.file}.log`;
    const marks = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    let now = 0;
    let most = 0;
    const pids: number[] = [];
    for (const line of marks) {
      const [mark, pid] = line.split(" ");
      now += mark === "+" ? 1 : mark === "-" ? -1 : 0;
      if (mark === "+") pids.push(Number(pid));
      most = Math.max(most, now);
    }
    return { started: pids.length, now, most, pids };
  }

  setHead(url: string, head: string): void {
    const all = parseRecord(readFileSync(this.file, "utf8"));
    const pr = all[url];
    if (typeof pr !== "object" || pr === null) throw new Error(`no PR ${url}: set it first`);
    publishRecord(this.file, { ...all, [url]: { ...pr, head } });
  }

  breakChecks(url: string): void {
    this.patch(url, { broken: true });
  }

  setDown(url: string, down: boolean): void {
    this.patch(url, { down });
  }

  private patch(url: string, change: Record<string, boolean>): void {
    const all = parseRecord(readFileSync(this.file, "utf8"));
    const pr = all[url];
    const kept = typeof pr === "object" && pr !== null ? pr : {};
    publishRecord(this.file, { ...all, [url]: { ...kept, ...change } });
  }

  state(url: string): unknown {
    const pr = parseRecord(readFileSync(this.file, "utf8"))[url];
    return typeof pr === "object" && pr !== null ? Reflect.get(pr, "state") : undefined;
  }
}
