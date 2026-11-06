import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./run-root.ts";

const FAKE = fileURLToPath(new URL("./fake-ssh.ts", import.meta.url));

type Mode = "healthy" | "wedged" | "down" | "wedged-down" | "fell-back-then-dropped";

export interface SshCall {
  readonly host: string;
  readonly direct: boolean;
  readonly command: string;
}

export class MuxSsh {
  readonly bin = tempDir("fleet-fake-ssh-");

  constructor() {
    const shim = join(this.bin, "ssh");
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${this.bin}' "$@"\n`);
    chmodSync(shim, 0o755);
  }

  set mode(mode: Mode) {
    writeFileSync(join(this.bin, "mode"), mode);
  }

  calls(): SshCall[] {
    let log: string;
    try {
      log = readFileSync(join(this.bin, "calls.jsonl"), "utf8");
    } catch {
      return [];
    }
    return log
      .split("\n")
      .filter((line) => line !== "")
      .map((line): SshCall => {
        const call: unknown = JSON.parse(line);
        return {
          host: String(Reflect.get(Object(call), "host")),
          direct: Reflect.get(Object(call), "direct") === true,
          command: String(Reflect.get(Object(call), "command")),
        };
      });
  }
}
