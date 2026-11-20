import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./run-root.ts";

const FAKE = fileURLToPath(new URL("./fake-chrome-devtools-axi.ts", import.meta.url));

export class FakeBrowser {
  readonly bin = tempDir("fleet-browser-bin-");
  readonly state = tempDir("fleet-browser-state-");

  constructor() {
    const shim = join(this.bin, "chrome-devtools-axi");
    writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(FAKE)} "$@"\n`);
    chmodSync(shim, 0o755);
  }
}
