import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
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

export async function showTab(
  page: Page,
  address: string,
  label?: string,
  state = "live",
): Promise<void> {
  await page.goto(address);
  if (label !== undefined) {
    const tab = page.locator("#tabs li", { hasText: label });
    await waitFor(async () => (await tab.count()) > 0, `the tab ${label} to be listed`);
    await tab.click();
  }
  await waitFor(
    async () => (await page.locator("#live").textContent()) === state,
    `the picture to be ${state}`,
  );
}

export async function pointInPicture(
  page: Page,
  size: { readonly width: number; readonly height: number },
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await page.locator("#screen").evaluate((img: HTMLImageElement) => {
    const outer = img.getBoundingClientRect();
    return {
      left: outer.left + img.clientLeft,
      top: outer.top + img.clientTop,
      width: img.clientWidth,
      height: img.clientHeight,
    };
  });
  return {
    x: box.left + (x / size.width) * box.width,
    y: box.top + (y / size.height) * box.height,
  };
}
