import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./run-root.ts";

export class FakeElement {
  readonly home = tempDir("fleet-element-");
  private readonly log = join(this.home, "opened.log");
  private readonly result = join(this.home, "result");

  constructor(exitCode = 0) {
    appendFileSync(this.log, "");
    this.exitCode = exitCode;
    const script = join(this.home, "el");
    writeFileSync(
      script,
      `#!/bin/sh\n[ "$1" = open ] && printf '%s\\n' "$2" >> '${this.log}'\nread -r result < '${this.result}'\nexit "$result"\n`,
    );
    chmodSync(script, 0o755);
  }

  set exitCode(code: number) {
    writeFileSync(this.result, `${String(code)}\n`);
  }

  opened(): string[] {
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  }
}
