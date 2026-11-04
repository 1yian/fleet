import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser as Client, type Page } from "playwright";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { tempDir } from "../support/run-root.ts";

const VIEWER = fileURLToPath(
  new URL("../../packages/extension/src/browser-view.ts", import.meta.url),
);
const WAIT_MS = 15_000;

let lab: BrowserLab;
let client: Client;
let viewer: ReturnType<typeof spawnGuarded>;
let page: Page;
let url: string;
let first: RawWorker;
let second: RawWorker;

beforeEach(async () => {
  lab = await BrowserLab.start();
  first = await lab.worker("Users see one scrollbar");
  second = await lab.worker("Users see one footer");
  await first.act({ action: "open", url: lab.site.url("/a") });
  await second.act({ action: "open", url: lab.site.url("/b") });
  const home = tempDir("fleet-viewer-home-");
  mkdirSync(join(home, "config"));
  const lane = { lane: "main", url: lab.cardd.url, token: lab.mainToken };
  writeFileSync(join(home, "config", "lane.json"), JSON.stringify(lane));
  viewer = spawnGuarded("node", [VIEWER, home, "--open"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, FLEET_BROWSER_VIEW_OPEN: "0" },
  });
  let said = "";
  viewer.stdout?.setEncoding("utf8").on("data", (chunk: string) => (said += chunk));
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = /Fleet browser viewer: (\S+)/.exec(said)?.[1];
    if (found !== undefined) {
      url = found;
      break;
    }
    assert.ok(Date.now() < deadline, "the viewer did not print its address");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  client = await chromium.launch();
  page = await client.newPage({ viewport: { width: 1400, height: 900 } });
});
afterEach(async () => {
  const exited = new Promise((resolve) => viewer.once("exit", resolve));
  viewer.kill("SIGTERM");
  const stopped = await Promise.allSettled([exited, client.close(), lab.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const labels = (): Promise<string[]> => page.locator("#tabs li .card").allTextContents();

async function select(label: string): Promise<void> {
  await page.locator("#tabs li", { hasText: label }).click();
  await until(
    async () => (await page.locator("#live").textContent()) === "live",
    "the live picture",
  );
}

async function pageSize(who: RawWorker): Promise<{ width: number; height: number }> {
  const size: unknown = JSON.parse(
    await who.act({ action: "eval", expression: "[innerWidth, innerHeight]" }),
  );
  if (!Array.isArray(size) || typeof size[0] !== "number" || typeof size[1] !== "number")
    throw new Error("the page size is not a pair of numbers");
  return { width: size[0], height: size[1] };
}

async function clickAt(who: RawWorker, x: number, y: number): Promise<void> {
  const size = await pageSize(who);
  const box = await page.locator("#screen").boundingBox();
  assert.ok(box !== null);
  await page.mouse.click(
    box.x + (x / size.width) * box.width,
    box.y + (y / size.height) * box.height,
  );
}

test("the viewer lists one tab per card and shows the selected one live", async () => {
  await page.goto(url);
  await until(async () => (await labels()).length === 2, "both cards' tabs to be listed");
  assert.deepEqual(await labels(), ["c-1 users-see-one-scrollbar", "c-2 users-see-one-footer"]);
  assert.deepEqual(await page.locator("#tabs li .page").allTextContents(), ["Alpha", "Bravo"]);
  await select("c-2 users-see-one-footer");
  assert.equal(await page.locator("#address").textContent(), lab.site.url("/b"));
  const shown = await page.locator("#screen").evaluate((img: HTMLImageElement) => ({
    src: img.src.slice(0, 23),
    width: img.naturalWidth,
  }));
  assert.equal(shown.src, "data:image/jpeg;base64,");
  assert.ok(shown.width > 0);
  await second.act({ action: "close" });
  await until(async () => (await labels()).length === 1, "the closed tab to leave the list");
  assert.deepEqual(await labels(), ["c-1 users-see-one-scrollbar"]);
});

test("a click and keys in the picture reach the tab, so the captain can step in", async () => {
  await page.goto(url);
  await until(async () => (await labels()).length === 2, "both cards' tabs to be listed");
  await select("c-1 users-see-one-scrollbar");

  await clickAt(first, 120, 100);
  await until(
    async () => (await first.act({ action: "read", selector: "#n" })) === "1",
    "the click to count",
  );

  await clickAt(first, 120, 215);
  await page.keyboard.type("hi!");
  await page.locator("#paste").fill("123456");
  await page.locator("#paste").press("Enter");
  await until(
    async () =>
      (await first.act({ action: "eval", expression: "document.getElementById('q').value" })) ===
      '"hi!123456"',
    "the keys to be typed",
  );
  assert.equal(await second.act({ action: "read" }), "bravo page");
});

test("the viewer answers only on its own address", async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const target = new URL(url);
    const probe = request(
      {
        host: target.hostname,
        port: target.port,
        path: "/api/tabs",
        headers: { host: "evil.example" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    probe.on("error", reject);
    probe.end();
  });
  assert.equal(status, 403);
});
