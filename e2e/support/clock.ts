import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tempDir } from "./run-root.ts";

const PRELOAD = fileURLToPath(new URL("./clock-preload.ts", import.meta.url));
const SEEN_MS = 60;

export class TestClock {
  private readonly file = join(tempDir("clock-"), "skew");
  private skewMs = 0;

  constructor() {
    writeFileSync(this.file, "0");
  }

  env(base: Record<string, string> = {}): Record<string, string> {
    const options = base["NODE_OPTIONS"] ?? process.env["NODE_OPTIONS"] ?? "";
    return {
      ...base,
      FLEET_E2E_CLOCK: this.file,
      NODE_OPTIONS: `${options} --import=${PRELOAD}`.trim(),
    };
  }

  async advance(ms: number): Promise<void> {
    this.skewMs += ms;
    writeFileSync(this.file, String(this.skewMs));
    await delay(SEEN_MS);
  }
}
