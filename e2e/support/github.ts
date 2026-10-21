import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord } from "./json.ts";

const FAKE = fileURLToPath(new URL("./fake-gh.ts", import.meta.url));

type Bucket = "pass" | "fail" | "pending";

export class FakeGitHub {
  private readonly dir = mkdtempSync(join(tmpdir(), "fleet-gh-"));
  private readonly file = join(this.dir, "prs.json");

  constructor() {
    writeFileSync(this.file, "{}");
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
    writeFileSync(this.file, JSON.stringify({ ...all, [url]: pr }));
  }

  slow(ms: number): void {
    const all = parseRecord(readFileSync(this.file, "utf8"));
    writeFileSync(this.file, JSON.stringify({ ...all, $delay: ms }));
  }

  callsInFlight(): { started: number; most: number } {
    const log = `${this.file}.log`;
    const marks = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    let now = 0;
    let most = 0;
    for (const mark of marks) {
      now += mark === "+" ? 1 : mark === "-" ? -1 : 0;
      most = Math.max(most, now);
    }
    return { started: marks.filter((mark) => mark === "+").length, most };
  }

  setHead(url: string, head: string): void {
    const all = parseRecord(readFileSync(this.file, "utf8"));
    const pr = all[url];
    if (typeof pr !== "object" || pr === null) throw new Error(`no PR ${url}: set it first`);
    writeFileSync(this.file, JSON.stringify({ ...all, [url]: { ...pr, head } }));
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
    writeFileSync(this.file, JSON.stringify({ ...all, [url]: { ...kept, ...change } }));
  }

  state(url: string): unknown {
    const pr = parseRecord(readFileSync(this.file, "utf8"))[url];
    return typeof pr === "object" && pr !== null ? Reflect.get(pr, "state") : undefined;
  }
}
