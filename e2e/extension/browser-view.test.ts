import assert from "node:assert/strict";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser as Client, type Page } from "playwright";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { isRecord } from "../support/json.ts";
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
  lab = await BrowserLab.start({ proxied: true });
  first = await lab.worker("Users see one scrollbar");
  second = await lab.worker("Users see one footer");
  await first.act({ action: "open", url: lab.site.url("/a") });
  await second.act({ action: "open", url: lab.site.url("/b") });
  const access = join(tempDir("fleet-viewer-access-"), "access.json");
  writeFileSync(access, JSON.stringify({ url: lab.cardd.url, token: lab.mainToken }), {
    mode: 0o600,
  });
  viewer = spawnGuarded("node", [VIEWER, "--access", access, "--open"], {
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

test("every route needs the viewer's token, and the tokened address works", async () => {
  const tokened = new URL(url);
  const token = tokened.searchParams.get("t") ?? "";
  assert.ok(token.length >= 32);
  const bare = (path: string): URL => new URL(path, tokened.origin);
  const routes: { path: string; method: string }[] = [
    { path: "/", method: "GET" },
    { path: "/api/tabs", method: "GET" },
    { path: "/api/stream?target=any", method: "GET" },
    { path: "/api/input", method: "POST" },
    { path: "/anything", method: "GET" },
  ];
  for (const { path, method } of routes) {
    const refused = await fetch(bare(path), { method, body: method === "POST" ? "{}" : null });
    assert.equal(refused.status, 403, `${method} ${path} without a token`);
    const withheld = new URL(bare(path));
    withheld.searchParams.set("t", `${token}x`);
    const wrong = await fetch(withheld, { method, body: method === "POST" ? "{}" : null });
    assert.equal(wrong.status, 403, `${method} ${path} with a wrong token`);
  }

  const listed = new URL(bare("/api/tabs"));
  listed.searchParams.set("t", token);
  const tabs = await fetch(listed);
  assert.equal(tabs.status, 200);
  const listing: unknown = await tabs.json();
  assert.ok(isRecord(listing) && Array.isArray(listing["tabs"]));
  assert.equal(listing["tabs"].length, 2);

  const entered = await fetch(url, { redirect: "manual" });
  assert.equal(entered.status, 302);
  assert.equal(entered.headers.get("location"), "/");
  const cookie = entered.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const withCookie = await fetch(bare("/api/tabs"), {
    headers: { cookie: cookie.split(";")[0] ?? "" },
  });
  assert.equal(withCookie.status, 200);
});

test("when the connection to Chrome drops and returns, the picture follows the page again", async () => {
  const proxy = lab.proxy;
  assert.ok(proxy !== undefined);
  await page.addInitScript(() => {
    Object.defineProperty(window, "setInterval", { value: () => 0 });
  });
  await page.goto(url);
  await until(async () => (await labels()).length === 2, "both cards' tabs to be listed");
  await select("c-1 users-see-one-scrollbar");
  const shown = (): Promise<string> =>
    page.locator("#screen").evaluate((img: HTMLImageElement) => img.src);

  await proxy.stop();
  await until(
    async () => (await page.locator("#live").textContent()) === "reconnecting",
    "the picture to notice that Chrome is gone",
  );
  await proxy.listen();
  await until(
    async () => (await page.locator("#live").textContent()) === "live",
    "the picture to come back",
  );

  const before = await shown();
  await first.act({ action: "click", selector: "#count" });
  await until(async () => (await shown()) !== before, "the picture to show the click");
});
