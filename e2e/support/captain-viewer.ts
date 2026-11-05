import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserLab } from "./browser-lab.ts";
import { WORKER_HOST } from "./fleet.ts";
import { spawnGuarded } from "./guarded.ts";
import { tempDir } from "./run-root.ts";

const VIEWER = fileURLToPath(
  new URL("../../packages/extension/src/browser-view.ts", import.meta.url),
);
const WAIT_MS = 15_000;

export interface CaptainViewer {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

export async function startViewer(
  lab: BrowserLab,
  flags: readonly string[],
  env: Record<string, string> = {},
): Promise<CaptainViewer> {
  const access = join(tempDir("fleet-viewer-access-"), "access.json");
  writeFileSync(
    access,
    JSON.stringify({ url: lab.cardd.url, token: lab.mainToken, host: WORKER_HOST }),
    { mode: 0o600 },
  );
  const viewer = spawnGuarded("node", [VIEWER, "--access", access, "--open", ...flags], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, FLEET_BROWSER_VIEW_OPEN: "0", ...env },
  });
  let said = "";
  viewer.stdout?.setEncoding("utf8").on("data", (chunk: string) => (said += chunk));
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = /Fleet browser viewer \((?:captain|gated)\): (\S+)/.exec(said)?.[1];
    if (found !== undefined)
      return {
        url: found,
        stop: async () => {
          const exited = new Promise((resolve) => viewer.once("exit", resolve));
          viewer.kill("SIGTERM");
          await exited;
        },
      };
    assert.ok(Date.now() < deadline, "the viewer did not print its address");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
