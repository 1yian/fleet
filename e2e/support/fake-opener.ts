import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./run-root.ts";

export class FakeOpener {
  readonly dir = tempDir("fleet-opener-");
  private readonly log = join(this.dir, "opened.log");

  constructor() {
    appendFileSync(this.log, "");
    for (const name of ["open", "xdg-open"]) {
      const script = join(this.dir, name);
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${this.log}'\n`);
      chmodSync(script, 0o755);
    }
  }

  opened(): string[] {
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  }
}
