import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chromium, devices, type Browser as Client, type Route } from "playwright";
import { Stream } from "../support/browser-herdr.ts";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { parseRecord, records } from "../support/json.ts";
import { startViewer, stopViewers, type Viewers } from "../support/viewer.ts";

const WAIT_MS = 15_000;

let lab: BrowserLab;
let worker: RawWorker;
const viewers: Viewers = [];
let client: Client | undefined;

beforeEach(async () => {
  lab = await BrowserLab.start({ gated: true });
  worker = await lab.worker("Sign in on a phone");
  await worker.act({ action: "open", url: lab.site.url("/a") });
});

afterEach(async () => {
  const stopped = await Promise.allSettled([client?.close(), ...stopViewers(viewers), lab.stop()]);
  client = undefined;
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function remoteSize(): Promise<string> {
  return JSON.stringify(
    JSON.parse(await worker.act({ action: "eval", expression: "[innerWidth, innerHeight]" })),
  );
}

interface Session {
  readonly cookie: string;
  readonly origin: string;
  readonly target: string;
}

async function enter(address: string): Promise<Session> {
  const entered = await fetch(address, { redirect: "manual" });
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  const origin = new URL(address).origin;
  const listing = parseRecord(
    await (await fetch(`${origin}/api/tabs`, { headers: { cookie } })).text(),
  );
  const target = records(listing["tabs"])[0]?.["target"];
  assert.equal(typeof target, "string");
  return { cookie, origin, target: String(target) };
}

const fit = (session: Session, body: object): Promise<Response> =>
  fetch(`${session.origin}/api/fit`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ target: session.target, ...body }),
  });

async function watching(session: Session): Promise<Stream> {
  const abort = new AbortController();
  const response = await fetch(
    `${session.origin}/api/stream?target=${encodeURIComponent(session.target)}`,
    { headers: { cookie: session.cookie }, signal: abort.signal },
  );
  assert.equal(response.status, 200);
  return new Stream(response, abort);
}

test("a captain's viewer on a phone shrinks the tab to the phone's screen while it watches, and gives the window back when it leaves", async () => {
  const captain = await startViewer(lab, viewers, ["--captain"]);
  const session = await enter(captain.url);
  const window = await remoteSize();
  const stream = await watching(session);
  await until(() => stream.messages.length > 0, "the first picture");

  const refused = await fit(session, { width: 50, height: 50, scale: 2 });
  assert.notEqual(refused.status, 204, "a screen too small to be a phone is refused");
  assert.equal(await remoteSize(), window);

  const shrunk = await fit(session, { width: 390, height: 640, scale: 2 });
  assert.equal(shrunk.status, 204);
  assert.equal(await remoteSize(), "[390,640]");
  await until(() => stream.messages.at(-1)?.["width"] === 390, "a picture of the phone-sized tab");
  assert.equal(stream.messages.at(-1)?.["height"], 640);

  await stream.stop();
  await until(async () => (await remoteSize()) === window, "the tab to get its window back");
});

test("fitting is only for the captain's viewer, and the captain can give the window back at once", async () => {
  const captain = await startViewer(lab, viewers, ["--captain"]);
  const gated = await startViewer(lab, viewers, []);
  const session = await enter(captain.url);
  const window = await remoteSize();
  const stream = await watching(session);
  await until(() => stream.messages.length > 0, "the first picture");

  const shrunk = await fit(session, { width: 390, height: 640, scale: 2 });
  assert.equal(shrunk.status, 204);
  assert.equal(await remoteSize(), "[390,640]");
  const restored = await fit(session, { clear: true });
  assert.equal(restored.status, 204);
  assert.equal(await remoteSize(), window);
  await stream.stop();

  const gatedSession = await enter(gated.url);
  const refused = await fit(gatedSession, { width: 390, height: 640, scale: 2 });
  assert.equal(refused.status, 404);
  assert.equal(await remoteSize(), window);
});

test("a fit that reaches Chrome after the viewer stopped watching the tab does not leave the tab at the phone's size", async () => {
  const gate = lab.gate;
  assert.ok(gate !== undefined);
  const captain = await startViewer(lab, viewers, ["--captain"]);
  const session = await enter(captain.url);
  const window = await remoteSize();
  const stream = await watching(session);
  await until(() => stream.messages.length > 0, "the first picture");

  gate.hold("Emulation.setDeviceMetricsOverride", 1);
  const fitting = fit(session, { width: 390, height: 640, scale: 2 });
  await until(() => gate.holding() === 1, "the fit to be held on its way to Chrome");
  const stops = gate.count("Page.stopScreencast");
  await stream.stop();
  await until(
    () => gate.count("Page.stopScreencast") > stops,
    "the viewer to stop watching the tab",
  );

  gate.release();
  await fitting;
  await until(async () => (await remoteSize()) === window, "the tab to get its window back");
});

test("phone: a shorter fit that is slow to arrive cannot overwrite the full-height fit that was asked for after it", async () => {
  const gate = lab.gate;
  assert.ok(gate !== undefined);
  const captain = await startViewer(lab, viewers, ["--captain"]);
  client = await chromium.launch();
  const context = await client.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  await page.goto(captain.url);
  await page.locator("#tabs li").first().waitFor();
  await until(async () => (await page.locator("#live").textContent()) === "live", "a live picture");
  const phone = page.viewportSize();
  assert.ok(phone !== null);
  const full = { size: "", height: 0 };
  await until(async () => {
    const box = await page.locator("#stage").boundingBox();
    assert.ok(box !== null);
    full.height = Math.floor(box.height);
    full.size = JSON.stringify([phone.width, full.height]);
    return (await remoteSize()) === full.size;
  }, "the tab to take the phone's size");

  const held: { route: Route | undefined } = { route: undefined };
  await page.route("**/api/fit", async (route) => {
    const height = Number(parseRecord(route.request().postData() ?? "{}")["height"]);
    if (held.route === undefined && height < full.height - 50) held.route = route;
    else await route.continue();
  });
  const applied = gate.count("Emulation.setDeviceMetricsOverride");
  await page.locator("#keyboard").tap();
  await until(() => held.route !== undefined, "the shorter fit to be held on its way");
  const wanted = await page.evaluate("fitted");
  await page.locator("#keyboard").tap();
  await until(
    async () => (await page.evaluate("fitted")) !== wanted,
    "the full size to be asked for",
  );

  assert.ok(held.route !== undefined);
  await held.route.continue();
  await until(
    () => gate.count("Emulation.setDeviceMetricsOverride") >= applied + 2,
    "both fits to reach Chrome",
  );
  await until(async () => (await remoteSize()) === full.size, "the tab to end at its full height");
});
