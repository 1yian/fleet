import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chromium, type Browser as Client } from "playwright";
import { Stream } from "../support/browser-herdr.ts";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { startViewer, type CaptainViewer } from "../support/captain-viewer.ts";
import { DelayProxy } from "../support/delay-proxy.ts";
import { parseRecord, records } from "../support/json.ts";

const WAIT_MS = 20_000;
const ONE_WAY_MS = 150;
const TYPED = "captain@example.test";

let lab: BrowserLab;
let worker: RawWorker;
let viewer: CaptainViewer;
let client: Client | undefined;
let proxy: DelayProxy | undefined;

beforeEach(async () => {
  lab = await BrowserLab.start({ proxied: true });
  worker = await lab.worker("Sign in on a slow link");
  await worker.act({ action: "open", url: lab.site.url("/a") });
  viewer = await startViewer(lab, ["--captain"]);
});

afterEach(async () => {
  const stopped = await Promise.allSettled([
    client?.close(),
    proxy?.stop(),
    viewer.stop(),
    lab.stop(),
  ]);
  client = undefined;
  proxy = undefined;
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const onRemote = async (expression: string): Promise<unknown> =>
  JSON.parse(await worker.act({ action: "eval", expression }));

test("typing on a slow link reaches the tab in a few round trips, not one round trip for each key", async () => {
  const shown = new URL(viewer.url);
  proxy = await DelayProxy.start(Number(shown.port), ONE_WAY_MS);
  client = await chromium.launch();
  const page = await client.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`http://127.0.0.1:${String(proxy.port)}/${shown.search}`);
  await page.locator("#tabs li").first().waitFor();
  if ((await page.locator("#live").textContent()) !== "live")
    await page.locator("#tabs li").first().click();
  await until(async () => (await page.locator("#live").textContent()) === "live", "a live picture");

  const measured = await onRemote(
    "(() => { const r = document.getElementById('q').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, innerWidth, innerHeight]; })()",
  );
  assert.ok(Array.isArray(measured) && measured.every((each) => typeof each === "number"));
  const [x = 0, y = 0, width = 1, height = 1] = measured;
  const box = await page.locator("#screen").boundingBox();
  assert.ok(box !== null);
  await page.mouse.click(box.x + (x / width) * box.width, box.y + (y / height) * box.height);
  await until(
    async () => (await onRemote("document.activeElement?.id")) === "q",
    "the field to take focus",
  );

  const began = Date.now();
  await page.keyboard.type(TYPED, { delay: 30 });
  await until(
    async () => (await onRemote("document.getElementById('q').value")) === TYPED,
    "the whole text in the tab",
  );
  const took = Date.now() - began;
  const roundTrip = ONE_WAY_MS * 2;
  assert.ok(
    took < TYPED.length * 30 + 4 * roundTrip,
    `${String(TYPED.length)} keys took ${String(took)} ms on a ${String(roundTrip)} ms round trip`,
  );
});

test("a viewer that has not shown its last picture gets the newest one next, not each picture in between", async () => {
  const origin = new URL(viewer.url).origin;
  const entered = await fetch(viewer.url, { redirect: "manual" });
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  const listing = parseRecord(
    await (await fetch(`${origin}/api/tabs`, { headers: { cookie } })).text(),
  );
  const target = String(records(listing["tabs"])[0]?.["target"]);
  const open = async (query: string): Promise<Stream> => {
    const abort = new AbortController();
    const response = await fetch(
      `${origin}/api/stream?target=${encodeURIComponent(target)}${query}`,
      { headers: { cookie }, signal: abort.signal },
    );
    assert.equal(response.status, 200);
    return new Stream(response, abort);
  };
  const resize = (width: number): Promise<Response> =>
    fetch(`${origin}/api/fit`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ target, width, height: 500, scale: 1 }),
    });
  const widths = (stream: Stream): unknown[] => stream.messages.map((message) => message["width"]);

  const slow = await open("&id=slowviewer");
  const quick = await open("");
  try {
    await until(() => slow.messages.length >= 1 && quick.messages.length >= 1, "a first picture");
    for (const width of [300, 320, 340, 360]) assert.equal((await resize(width)).status, 204);
    await until(
      () => quick.messages.at(-1)?.["width"] === 360,
      "the last picture on the quick viewer",
    );
    assert.equal((await fetch(`${origin}/api/tabs`, { headers: { cookie } })).status, 200);
    assert.equal(slow.messages.length, 1, "no picture is sent while the last one is not shown");

    const acknowledged = await fetch(`${origin}/api/ack?id=slowviewer`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(acknowledged.status, 204);
    await until(() => slow.messages.at(-1)?.["width"] === 360, "the newest picture");
    assert.equal(slow.messages.length, 2, `got ${JSON.stringify(widths(slow))}`);
  } finally {
    await Promise.all([slow.stop(), quick.stop()]);
  }
});
