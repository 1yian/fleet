import assert from "node:assert/strict";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_OPS, check } from "@fleet/protocol";
import { chromium, type Browser as Client, type Page } from "playwright";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { Stream } from "../support/browser-herdr.ts";
import { WORKER_HOST } from "../support/fleet.ts";
import { isRecord } from "../support/json.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { tabOf } from "../support/login-fixtures.ts";
import { tempDir } from "../support/run-root.ts";

const VIEWER = fileURLToPath(
  new URL("../../packages/extension/src/browser-view.ts", import.meta.url),
);
const WAIT_MS = 15_000;

let lab: BrowserLab;
let client: Client;
const viewers: ReturnType<typeof spawnGuarded>[] = [];
let page: Page;
let url: string;
let first: RawWorker;
let second: RawWorker;

interface Started {
  readonly url: string;
  readonly said: () => string;
}

async function start(flags: string[], env: Record<string, string> = {}): Promise<Started> {
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
  viewers.push(viewer);
  let said = "";
  viewer.stdout?.setEncoding("utf8").on("data", (chunk: string) => (said += chunk));
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = /Fleet browser viewer \((?:captain|gated)\): (\S+)/.exec(said)?.[1];
    if (found !== undefined) return { url: found, said: () => said };
    assert.ok(Date.now() < deadline, "the viewer did not print its address");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const launch = async (flags: string[]): Promise<string> => (await start(flags)).url;

beforeEach(async () => {
  lab = await BrowserLab.start({ proxied: true });
  first = await lab.worker("Users see one scrollbar");
  second = await lab.worker("Users see one footer");
  await first.act({ action: "open", url: lab.site.url("/a") });
  await second.act({ action: "open", url: lab.site.url("/b") });
  url = await launch(["--captain"]);
  client = await chromium.launch();
  page = await client.newPage({ viewport: { width: 1400, height: 900 } });
});
afterEach(async () => {
  const exits = viewers.splice(0).map((viewer) => {
    const exited = new Promise((resolve) => viewer.once("exit", resolve));
    viewer.kill("SIGTERM");
    return exited;
  });
  const stopped = await Promise.allSettled([...exits, client.close(), lab.stop()]);
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
  assert.equal(entered.status, 200);
  assert.match(await entered.text(), /location\.replace\("\/"\)/);
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

test("a gated viewer draws a picture that cardd took, and shows a note instead when cardd cannot get one", async () => {
  const proxy = lab.proxy;
  assert.ok(proxy !== undefined);
  const gated = await launch([]);
  await page.addInitScript(() => {
    Object.defineProperty(window, "setInterval", { value: () => 0 });
  });
  await page.goto(gated);
  await until(async () => (await labels()).length === 2, "both cards' tabs to be listed");
  await select("c-1 users-see-one-scrollbar");
  assert.equal(await page.locator("#note").isHidden(), true);

  await proxy.stop();
  await until(
    async () => (await page.locator("#live").textContent()) === "hidden",
    "the viewer to hide the picture while cardd cannot reach Chrome",
  );
  assert.match(await page.locator("#note").innerText(), /^Hidden: /);
  assert.equal(await page.locator("#screen").isHidden(), true);
  await proxy.listen();
  await until(
    async () => (await page.locator("#live").textContent()) === "live",
    "the picture to come back",
  );
  assert.equal(await page.locator("#note").isHidden(), true);

  const before = await page.locator("#screen").evaluate((img: HTMLImageElement) => img.src);
  await first.act({ action: "click", selector: "#count" });
  await until(
    async () =>
      (await page.locator("#screen").evaluate((img: HTMLImageElement) => img.src)) !== before,
    "the picture to show the click",
  );
});

test("two viewers in one browser profile each keep their own session", async () => {
  const target = await tabOf(lab, first);
  const gated = await launch([]);
  const context = await client.newContext({ viewport: { width: 1400, height: 900 } });
  const captainPage = await context.newPage();
  await captainPage.goto(url);
  const gatedPage = await context.newPage();
  await gatedPage.goto(gated);
  const statuses = (from: Page): Promise<number[]> =>
    from.evaluate(async (id) => {
      const tabs = await fetch("/api/tabs");
      const stream = await fetch(`/api/stream?target=${encodeURIComponent(id)}`);
      await stream.body?.cancel();
      const input = await fetch("/api/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: id, kind: "click", x: 5, y: 5 }),
      });
      return [tabs.status, stream.status, input.status];
    }, target);

  assert.deepEqual(await statuses(captainPage), [200, 200, 204]);
  assert.deepEqual(await statuses(gatedPage), [200, 200, 204]);
  assert.equal((await context.cookies()).length, 2);
});

test("only main's own session may ask for the captain's view of a tab, and a frame is only of a tab the caller may see", async () => {
  const cleo = await lab.cardd.connect(lab.cardd.addLane("cleo", "main"));
  try {
    const target = await tabOf(lab, first);
    const foreign = await tabOf(lab, second);
    const refused = /only main's own session may ask for the captain's view of a tab/;
    await assert.rejects(first.session.call("browser.view", { captain: true }), refused);
    await assert.rejects(cleo.call("browser.view", { captain: true }), refused);
    const raw = check(
      BROWSER_OPS["browser.view"].result,
      await lab.main.call("browser.view", { captain: true }),
    );
    assert.equal(raw.tabs.length, 2);

    const frame = BROWSER_OPS["browser.frame"].result;
    const own = check(frame, await first.session.call("browser.frame", { target }));
    assert.equal(own.note, null);
    assert.equal(own.image?.mimeType, "image/jpeg");
    assert.ok(own.image.data.length > 0);
    assert.equal(
      check(frame, await lab.main.call("browser.frame", { target: foreign })).note,
      null,
    );
    await assert.rejects(
      first.session.call("browser.frame", { target: foreign }),
      /that tab is not open, or it is not yours to see/,
    );
    await assert.rejects(
      cleo.call("browser.frame", { target }),
      /that tab is not open, or it is not yours to see/,
    );
  } finally {
    await cleo.close();
  }
});

test("with no tab the viewer shows one empty state, and with tabs but none picked it only asks for a pick", async () => {
  await page.goto(url);
  await until(async () => (await labels()).length === 2, "both cards' tabs to be listed");
  const note = page.locator("#note");
  await until(
    async () => (await note.textContent()) === "Pick a tab on the left.",
    "the pick note",
  );
  for (const quiet of ["#live", "#hint", "#paste", "#screen"])
    assert.equal(await page.locator(quiet).isHidden(), true, `${quiet} while nothing is picked`);

  await first.act({ action: "close" });
  await second.act({ action: "close" });
  await until(async () => (await labels()).length === 0, "the closed tabs to leave the list");
  await until(
    async () => ((await note.textContent()) ?? "").startsWith("No tabs open."),
    "the empty note",
  );

  const shown = await page.locator("body").innerText();
  assert.equal(shown.match(/No tabs open/g)?.length, 1);
  assert.doesNotMatch(shown, /Pick a tab|idle|Click the picture/);
  for (const quiet of ["#live", "#hint", "#paste", "#screen"])
    assert.equal(await page.locator(quiet).isHidden(), true, `${quiet} with no tab`);
  assert.equal(await page.locator("#address").textContent(), "");
  assert.equal(await note.isVisible(), true);
});

async function watched(address: string, target: string): Promise<Stream> {
  const entered = await fetch(address, { redirect: "manual" });
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  const abort = new AbortController();
  const stream = new URL(`/api/stream?target=${encodeURIComponent(target)}`, address);
  const response = await fetch(stream, { headers: { cookie }, signal: abort.signal });
  assert.equal(response.status, 200);
  return new Stream(response, abort);
}

test("a gated viewer sends a picture again only when the page changed", async () => {
  const gated = await launch([]);
  const stream = await watched(gated, await tabOf(lab, first));
  try {
    await until(() => Promise.resolve(stream.messages.length >= 1), "the first picture");
    for (const beat of ["1", "2", "3"])
      await first.act({ action: "eval", expression: `document.body.dataset.beat = ${beat}` });
    assert.equal(stream.messages.length, 1);

    await first.act({
      action: "eval",
      expression: "document.getElementById('n').textContent = '7'",
    });
    await until(() => Promise.resolve(stream.messages.length >= 2), "the picture of the change");
    const [before, after] = stream.messages;
    assert.notEqual(before?.["data"], after?.["data"]);
    assert.equal(stream.messages.length, 2);
  } finally {
    await stream.stop();
  }
});

const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((each) => each?.family === "IPv4" && !each.internal)?.address;

function tailscaleSaying(status: object): string {
  const file = join(tempDir("fleet-tailnet-"), "tailscale");
  writeFileSync(file, `#!/bin/sh\necho '${JSON.stringify(status)}'\n`, { mode: 0o755 });
  return file;
}

const tailnet = (address: string, name: string): { FLEET_TAILSCALE: string } => ({
  FLEET_TAILSCALE: tailscaleSaying({
    BackendState: "Running",
    Self: { DNSName: name, TailscaleIPs: [address] },
  }),
});

function statusOf(address: string, port: string, host: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = request({ host: address, port, path, headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    probe.on("error", reject);
    probe.end();
  });
}

test("the captain's viewer prints the machine's tailnet address, still refuses a request with no token, and a worker's viewer stays on loopback", async (t) => {
  const address = lanAddress();
  if (address === undefined) {
    t.skip("this machine has no non-loopback IPv4 address to stand in for a tailnet address");
    return;
  }

  const bare = await start(["--captain"], tailnet(address, ""));
  const shown = new URL(bare.url);
  assert.equal(shown.hostname, address);
  assert.ok(!shown.hostname.startsWith("127.") && shown.hostname !== "0.0.0.0");
  const token = shown.searchParams.get("t") ?? "";
  assert.ok(token.length >= 32);
  assert.match(bare.said(), /listens on the tailnet address .* only, never on a public interface/);
  const denied = [
    new URL("/", shown.origin),
    new URL("/api/tabs", shown.origin),
    new URL(`/?t=${token}x`, shown.origin),
  ];
  for (const refused of denied) assert.equal((await fetch(refused)).status, 403, refused.href);
  assert.equal((await fetch(bare.url, { redirect: "manual" })).status, 200);
  await assert.rejects(fetch(`http://127.0.0.1:${shown.port}/`), "the viewer is not on loopback");

  const named = await start(["--captain"], tailnet(address, "Maverick.tail-test.ts.net."));
  const byName = new URL(named.url);
  assert.equal(byName.hostname, "maverick.tail-test.ts.net");
  const path = `/?t=${byName.searchParams.get("t") ?? ""}`;
  assert.equal(await statusOf(address, byName.port, byName.host, path), 200);
  assert.equal(await statusOf(address, byName.port, `${address}:${byName.port}`, path), 200);
  assert.equal(await statusOf(address, byName.port, `evil.example:${byName.port}`, path), 403);

  const worker = await start([], tailnet(address, "Maverick.tail-test.ts.net."));
  assert.equal(new URL(worker.url).hostname, "127.0.0.1");
});

test("a captain's viewer with no tailnet address falls back to loopback and says so in the tab", async () => {
  const alone = await start(["--captain"]);

  assert.equal(new URL(alone.url).hostname, "127.0.0.1");
  assert.match(
    alone.said(),
    /No tailnet address was found \(.+\), so this viewer listens on this machine only\. Open the link here: another machine cannot reach it\./,
  );
  assert.equal((await fetch(alone.url, { redirect: "manual" })).status, 200);
});
