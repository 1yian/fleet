import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord, publishRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";

const TOOL = fileURLToPath(new URL("./fake-whisper-tool.ts", import.meta.url));

export class FakeWhisper {
  readonly model: string;
  readonly ffmpeg: string;
  readonly whisper: string;
  private readonly state: string;

  constructor(transcript: readonly string[]) {
    const dir = tempDir("fleet-whisper-");
    this.model = join(dir, "ggml-test.bin");
    this.ffmpeg = join(dir, "ffmpeg");
    this.whisper = join(dir, "whisper-cli");
    this.state = join(dir, "state.json");
    writeFileSync(this.model, "model");
    publishRecord(this.state, { transcript });
    for (const [name, path] of [
      ["ffmpeg", this.ffmpeg],
      ["whisper-cli", this.whisper],
    ] as const) {
      writeFileSync(path, `#!/bin/sh\nexec node ${JSON.stringify(TOOL)} ${name} "$@"\n`);
      chmodSync(path, 0o755);
    }
  }

  get env(): Record<string, string> {
    return {
      BRIDGE_FFMPEG: this.ffmpeg,
      BRIDGE_WHISPER_CLI: this.whisper,
      BRIDGE_WHISPER_MODEL: this.model,
      FAKE_WHISPER_STATE: this.state,
    };
  }

  calls(tool: "ffmpeg" | "whisper-cli"): string[][] {
    const log = `${this.state}.log`;
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parseRecord(line))
      .filter((record) => record["tool"] === tool)
      .map((record) => {
        const args = record["args"];
        return Array.isArray(args) ? args.map(String) : [];
      });
  }
}
