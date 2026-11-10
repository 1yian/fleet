import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, optionalNumber, optionalString, parseRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";

const FAKE = fileURLToPath(new URL("./fake-socks-ssh.ts", import.meta.url));

export class SocksSsh {
  readonly bin = tempDir("fleet-socks-ssh-");

  constructor() {
    const shim = join(this.bin, "ssh");
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${this.bin}' "$@"\n`);
    chmodSync(shim, 0o755);
  }

  get path(): string {
    return `${this.bin}:${process.env["PATH"] ?? ""}`;
  }

  private calls(): Record<string, unknown>[] {
    try {
      return readFileSync(join(this.bin, "calls.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => parseRecord(line))
        .filter(isRecord);
    } catch {
      return [];
    }
  }

  destinations(): string[] {
    return this.calls().flatMap((call) =>
      call["kind"] === "socks" ? [optionalString(call, "destination") ?? ""] : [],
    );
  }

  forwards(): string[] {
    return this.calls().flatMap((call) =>
      call["kind"] === "forward"
        ? [`${optionalString(call, "host") ?? ""} ${optionalString(call, "address") ?? ""}`]
        : [],
    );
  }

  hostCommands(): number {
    return this.calls().filter((call) => call["kind"] === "command").length;
  }

  forwardPids(): number[] {
    return this.calls().flatMap((call) =>
      call["kind"] === "forward" ? [optionalNumber(call, "pid") ?? 0] : [],
    );
  }
}
