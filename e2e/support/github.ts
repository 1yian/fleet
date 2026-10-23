import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord, publishRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";

const FAKE = fileURLToPath(new URL("./fake-gh.ts", import.meta.url));
const FAKE_DIRENV = fileURLToPath(new URL("./fake-direnv.ts", import.meta.url));

export class FakeGitHub {
  private readonly dir = tempDir("fleet-gh-");
  private readonly file = join(this.dir, "prs.json");

  constructor() {
    publishRecord(this.file, {});
    const shim = join(this.dir, "gh");
    writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(FAKE)} "$@"\n`);
    chmodSync(shim, 0o755);
    const direnv = join(this.dir, "direnv");
    writeFileSync(direnv, `#!/bin/sh\nexec node ${JSON.stringify(FAKE_DIRENV)} "$@"\n`);
    chmodSync(direnv, 0o755);
  }

  get env(): Record<string, string> {
    return { PATH: `${this.dir}:${process.env["PATH"] ?? ""}`, FAKE_GH_STATE: this.file };
  }

  setPr(url: string, state: "OPEN" | "MERGED" | "CLOSED"): void {
    publishRecord(this.file, { ...parseRecord(readFileSync(this.file, "utf8")), [url]: { state } });
  }

  only(url: string, account: string): void {
    const all = parseRecord(readFileSync(this.file, "utf8"));
    const pr = all[url];
    if (typeof pr !== "object" || pr === null) throw new Error(`no PR ${url}`);
    publishRecord(this.file, { ...all, [url]: { ...pr, account } });
  }

  calls(): string[] {
    const log = `${this.file}.log`;
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];
  }

  state(url: string): unknown {
    const pr = parseRecord(readFileSync(this.file, "utf8"))[url];
    return typeof pr === "object" && pr !== null ? Reflect.get(pr, "state") : undefined;
  }
}
