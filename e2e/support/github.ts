// A fake GitHub for cardd: a gh shim on PATH and a state file the test controls.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  /** The environment that puts this fake gh in front of the real one. */
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
    writeFileSync(this.file, JSON.stringify({ ...all, [url]: { state, checks: list } }));
  }

  /** Makes `gh pr checks` fail with a network error from now on. */
  breakChecks(url: string): void {
    this.patch(url, { broken: true });
  }

  /** Makes every gh call for this PR fail with a network error, or work again. */
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
