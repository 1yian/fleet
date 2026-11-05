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

export type Viewers = ReturnType<typeof spawnGuarded>[];

export async function launchViewer(
  lab: BrowserLab,
  viewers: Viewers,
  flags: string[],
): Promise<string> {
  const access = join(tempDir("fleet-viewer-access-"), "access.json");
  writeFileSync(
    access,
    JSON.stringify({ url: lab.cardd.url, token: lab.mainToken, host: WORKER_HOST }),
    { mode: 0o600 },
  );
  const viewer = spawnGuarded("node", [VIEWER, "--access", access, "--open", ...flags], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, FLEET_BROWSER_VIEW_OPEN: "0" },
  });
  viewers.push(viewer);
  let said = "";
  viewer.stdout?.setEncoding("utf8").on("data", (chunk: string) => (said += chunk));
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = /Fleet browser viewer \((?:captain|gated)\): (\S+)/.exec(said)?.[1];
    if (found !== undefined) return found;
    assert.ok(Date.now() < deadline, "the viewer did not print its address");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function stopViewers(viewers: Viewers): Promise<unknown>[] {
  return viewers.splice(0).map((viewer) => {
    const exited = new Promise((resolve) => viewer.once("exit", resolve));
    viewer.kill("SIGTERM");
    return exited;
  });
}

export async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
