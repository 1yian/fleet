import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chromium, type Browser as Client, type Page, type Route } from "playwright";
import { Stream } from "../support/browser-herdr.ts";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { startViewer, type CaptainViewer } from "../support/captain-viewer.ts";
import { DelayProxy } from "../support/delay-proxy.ts";
import { parseRecord, records } from "../support/json.ts";

const WAIT_MS = 20_000;
const ONE_WAY_MS = 150;
const CHANGING_MS = 4_000;
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

interface Session {
  readonly cookie: string;
  readonly origin: string;
  readonly target: string;
}

async function enter(): Promise<Session> {
  const origin = new URL(viewer.url).origin;
  const entered = await fetch(viewer.url, { redirect: "manual" });
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  const listing = parseRecord(
    await (await fetch(`${origin}/api/tabs`, { headers: { cookie } })).text(),
  );
  return { cookie, origin, target: String(records(listing["tabs"])[0]?.["target"]) };
}

async function open(session: Session, id: string): Promise<Stream> {
  const abort = new AbortController();
  const response = await fetch(
    `${session.origin}/api/stream?target=${encodeURIComponent(session.target)}&id=${id}`,
    { headers: { cookie: session.cookie }, signal: abort.signal },
  );
  assert.equal(response.status, 200);
  return new Stream(response, abort);
}

const acknowledge = (session: Session, id: string): Promise<Response> =>
  fetch(`${session.origin}/api/ack?id=${id}`, {
    method: "POST",
    headers: { cookie: session.cookie },
  });

const resize = (session: Session, width: number): Promise<Response> =>
  fetch(`${session.origin}/api/fit`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ target: session.target, width, height: 500, scale: 1 }),
  });

test("a viewer that has not shown its last picture gets nothing while the page keeps changing, and the newest picture once it has", async () => {
  const session = await enter();
  const slow = await open(session, "slowviewer");
  const quick = await open(session, "quickviewer");
  let acknowledged = 0;
  const showing = async (width: number): Promise<boolean> => {
    for (; acknowledged < quick.messages.length; acknowledged += 1)
      assert.equal((await acknowledge(session, "quickviewer")).status, 204);
    return quick.messages.at(-1)?.["width"] === width;
  };
  try {
    await until(() => slow.messages.length >= 1 && quick.messages.length >= 1, "a first picture");
    const began = Date.now();
    let width = 300;
    for (let step = 0; Date.now() - began < CHANGING_MS; step += 1) {
      width = 300 + (step % 20) * 20;
      assert.equal((await resize(session, width)).status, 204);
      await until(
        () => showing(width),
        `the viewer that shows each picture to show ${String(width)}`,
      );
    }
    assert.ok(quick.messages.length > 5, "the page changed and the quick viewer kept up");
    assert.equal(
      slow.messages.length,
      1,
      `no picture is sent while the last one is not shown, got ${String(slow.messages.length)}`,
    );

    assert.equal((await acknowledge(session, "slowviewer")).status, 204);
    await until(() => slow.messages.at(-1)?.["width"] === width, "the newest picture");
    assert.equal(slow.messages.length, 2, "the pictures in between are never sent");
  } finally {
    await Promise.all([slow.stop(), quick.stop()]);
  }
});

test("an acknowledgement answers 204 for a stream the viewer has and 404 for one it does not", async () => {
  const session = await enter();
  const stream = await open(session, "knownviewer");
  try {
    await until(() => stream.messages.length >= 1, "a first picture");
    assert.equal((await acknowledge(session, "knownviewer")).status, 204);
    assert.equal((await acknowledge(session, "nobodyviewer")).status, 404);
  } finally {
    await stream.stop();
  }
  await until(
    async () => (await acknowledge(session, "knownviewer")).status === 404,
    "the viewer to forget the closed stream",
  );
});

test("a stream that names the id of a live stream takes its place, and the old response ends", async () => {
  const session = await enter();
  const old = await open(session, "sameviewer");
  await until(() => old.messages.length >= 1, "a first picture");
  const fresh = await open(session, "sameviewer");
  try {
    await until(() => old.ended && fresh.messages.length >= 1, "the old stream to end");
    assert.equal((await acknowledge(session, "sameviewer")).status, 204);
    assert.equal((await resize(session, 333)).status, 204);
    await until(
      () => fresh.messages.at(-1)?.["width"] === 333,
      "the new stream to show the change",
    );
    assert.equal(old.messages.length, 1, "nothing is written to the old stream");
  } finally {
    await Promise.all([old.stop(), fresh.stop()]);
  }
});

const RECORD_STREAMS = `
  window.__streams = [];
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    constructor(url, init) {
      super(url, init);
      const seen = { url: String(url), pictures: 0 };
      window.__streams.push(seen);
      this.addEventListener("message", () => { seen.pictures += 1; });
    }
  };
`;

async function streamsOf(page: Page): Promise<{ url: string; pictures: number }[]> {
  const seen: unknown = JSON.parse(String(await page.evaluate("JSON.stringify(window.__streams)")));
  return records(seen).map((each) => ({
    url: String(each["url"]),
    pictures: Number(each["pictures"]),
  }));
}

const showsGreen = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const picture = document.getElementById("screen");
    if (!(picture instanceof HTMLImageElement) || picture.naturalWidth === 0) return false;
    const canvas = document.createElement("canvas");
    canvas.width = picture.naturalWidth;
    canvas.height = picture.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) return false;
    context.drawImage(picture, 0, 0);
    const middle = context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
    return (middle[1] ?? 0) > 120 && (middle[0] ?? 255) < 60 && (middle[2] ?? 255) < 60;
  });

const LOSSES: readonly (readonly [string, (route: Route) => Promise<void> | void])[] = [
  ["cannot be sent", (route) => route.abort()],
  ["is answered with 404", (route) => route.fulfill({ status: 404 })],
  ["is never answered", () => undefined],
];

for (const [loss, lose] of LOSSES) {
  test(`a page whose acknowledgement ${loss} opens a new stream and shows the page as it is now`, async () => {
    client = await chromium.launch();
    const page = await client.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript(RECORD_STREAMS);
    let lost: string | null = null;
    await page.route("**/api/ack*", async (route) => {
      const id = new URL(route.request().url()).searchParams.get("id");
      lost ??= id;
      if (id === lost) await lose(route);
      else await route.continue();
    });
    await page.goto(viewer.url);
    await until(
      async () => (await streamsOf(page)).some((each) => each.pictures >= 1),
      "a picture",
    );

    await worker.act({ action: "open", url: lab.site.url("/tint-other") });
    await until(() => showsGreen(page), "the picture of the changed page");

    const seen = await streamsOf(page);
    assert.ok(seen.length >= 2, "the page opened a new stream");
    assert.equal(
      seen[0]?.pictures,
      1,
      "the stream whose acknowledgement was lost got nothing more",
    );
    assert.notEqual(seen[0].url, seen[1]?.url, "the new stream has an id of its own");
  });
}
