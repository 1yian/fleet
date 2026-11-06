import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chromium, type Browser as Client, type Page, type Route } from "playwright";
import { Stream } from "../support/browser-herdr.ts";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { startViewer, stopViewers, type Started, type Viewers } from "../support/viewer.ts";
import { DelayProxy } from "../support/delay-proxy.ts";
import { parseRecord, records } from "../support/json.ts";

const WAIT_MS = 20_000;
const ONE_WAY_MS = 150;
const CHANGING_MS = 4_000;
const TYPED = "captain@example.test";

let lab: BrowserLab;
let worker: RawWorker;
let viewer: Started;
const viewers: Viewers = [];
let client: Client | undefined;
let proxy: DelayProxy | undefined;

beforeEach(async () => {
  lab = await BrowserLab.start({ gated: true });
  worker = await lab.worker("Sign in on a slow link");
  await worker.act({ action: "open", url: lab.site.url("/a") });
  viewer = await startViewer(lab, viewers, ["--captain"]);
});

afterEach(async () => {
  const stopped = await Promise.allSettled([
    client?.close(),
    proxy?.stop(),
    ...stopViewers(viewers),
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

const connect = (session: Session, id: string, abort: AbortController): Promise<Response> =>
  fetch(`${session.origin}/api/stream?target=${encodeURIComponent(session.target)}&id=${id}`, {
    headers: { cookie: session.cookie },
    signal: abort.signal,
  });

async function open(session: Session, id: string): Promise<Stream> {
  const abort = new AbortController();
  const response = await connect(session, id, abort);
  assert.equal(response.status, 200);
  return new Stream(response, abort);
}

const acknowledge = (session: Session, id: string, seq?: number | string): Promise<Response> =>
  fetch(`${session.origin}/api/ack?id=${id}${seq === undefined ? "" : `&seq=${String(seq)}`}`, {
    method: "POST",
    headers: { cookie: session.cookie },
  });

const seqOf = (stream: Stream, index: number): number | undefined => {
  const seq = stream.messages[index]?.["seq"];
  return typeof seq === "number" ? seq : undefined;
};

const settled = async (session: Session): Promise<void> => {
  assert.equal(
    (await fetch(`${session.origin}/api/tabs`, { headers: { cookie: session.cookie } })).status,
    200,
  );
};

function showsEach(
  session: Session,
  id: string,
  stream: Stream,
): (width: number) => Promise<boolean> {
  let done = 0;
  return async (width) => {
    for (; done < stream.messages.length; done += 1)
      assert.equal((await acknowledge(session, id, seqOf(stream, done))).status, 204);
    return stream.messages.at(-1)?.["width"] === width;
  };
}

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
  const showing = showsEach(session, "quickviewer", quick);
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

    assert.equal((await acknowledge(session, "slowviewer", seqOf(slow, 0))).status, 204);
    await until(() => slow.messages.at(-1)?.["width"] === width, "the newest picture");
    assert.equal(slow.messages.length, 2, "the pictures in between are never sent");
  } finally {
    await Promise.all([slow.stop(), quick.stop()]);
  }
});

test("an acknowledgement answers 204 for a stream the viewer has, 404 for one it does not, and 400 with no picture number", async () => {
  const session = await enter();
  const stream = await open(session, "knownviewer");
  try {
    await until(() => stream.messages.length >= 1, "a first picture");
    const seq = seqOf(stream, 0);
    assert.equal((await acknowledge(session, "knownviewer", seq)).status, 204);
    assert.equal((await acknowledge(session, "nobodyviewer", seq)).status, 404);
    assert.equal((await acknowledge(session, "knownviewer")).status, 400);
    assert.equal((await acknowledge(session, "knownviewer", "later")).status, 400);
  } finally {
    await stream.stop();
  }
  await until(
    async () => (await acknowledge(session, "knownviewer", 1)).status === 404,
    "the viewer to forget the closed stream",
  );
});

test("an acknowledgement that arrives twice, as a retry after a lost answer does, releases one picture and not the next", async () => {
  const session = await enter();
  const slow = await open(session, "retryviewer");
  const quick = await open(session, "controlviewer");
  const showing = showsEach(session, "controlviewer", quick);
  try {
    await until(() => slow.messages.length >= 1 && quick.messages.length >= 1, "a first picture");
    assert.equal((await resize(session, 300)).status, 204);
    await until(() => showing(300), "the first change on the viewer that shows each picture");
    assert.equal((await acknowledge(session, "retryviewer", seqOf(slow, 0))).status, 204);
    await until(() => slow.messages.at(-1)?.["width"] === 300, "the second picture");
    assert.equal(slow.messages.length, 2);

    for (const width of [320, 340, 360]) assert.equal((await resize(session, width)).status, 204);
    await until(() => showing(360), "the last picture on the viewer that shows each picture");
    assert.equal((await acknowledge(session, "retryviewer", seqOf(slow, 0))).status, 204);
    await settled(session);
    assert.equal(slow.messages.length, 2, "the repeated acknowledgement released nothing");

    assert.equal((await acknowledge(session, "retryviewer", seqOf(slow, 1))).status, 204);
    await until(() => slow.messages.at(-1)?.["width"] === 360, "the newest picture");
    assert.equal(slow.messages.length, 3);
  } finally {
    await Promise.all([slow.stop(), quick.stop()]);
  }
});

test("a stream that names the id of a live stream takes its place, and an acknowledgement of the old stream's picture releases nothing", async () => {
  const session = await enter();
  const old = await open(session, "sameviewer");
  await until(() => old.messages.length >= 1, "a first picture");
  const fresh = await open(session, "sameviewer");
  const quick = await open(session, "controlviewer");
  const showing = showsEach(session, "controlviewer", quick);
  try {
    await until(
      () => old.ended && fresh.messages.length >= 1 && quick.messages.length >= 1,
      "the old stream to end",
    );
    assert.notEqual(
      seqOf(old, 0),
      seqOf(fresh, 0),
      "each stream's pictures have numbers of their own",
    );

    assert.equal((await acknowledge(session, "sameviewer", seqOf(old, 0))).status, 204);
    assert.equal((await resize(session, 333)).status, 204);
    await until(() => showing(333), "the page change on the viewer that shows each picture");
    await settled(session);
    assert.equal(fresh.messages.length, 1, "the old stream's acknowledgement released nothing");

    assert.equal((await acknowledge(session, "sameviewer", seqOf(fresh, 0))).status, 204);
    await until(
      () => fresh.messages.at(-1)?.["width"] === 333,
      "the new stream to show the change",
    );
    assert.equal(old.messages.length, 1, "nothing is written to the old stream");
  } finally {
    await Promise.all([old.stop(), fresh.stop(), quick.stop()]);
  }
});

test("a stream that joins a tab while another stream is still starting on it keeps its pictures when the first one ends", async () => {
  const gate = lab.gate;
  assert.ok(gate !== undefined);
  const session = await enter();
  gate.hold("Page.startScreencast", 1);
  gate.hold("Page.captureScreenshot", 1);
  const early = new AbortController();
  const late = new AbortController();
  const earlyOpened = connect(session, "earlyviewer", early).catch(() => undefined);
  await until(() => gate.holding() === 1, "the first stream to start the tab's pictures");
  const lateOpened = connect(session, "lateviewer", late).catch(() => undefined);
  await until(() => gate.holding() === 2, "the second stream to ask Chrome for a picture");

  const stops = gate.count("Page.stopScreencast");
  early.abort();
  gate.release();
  await until(
    () => gate.count("Page.stopScreencast") > stops,
    "the first stream to let go of the tab",
  );
  gate.release();

  const response = await lateOpened;
  assert.ok(response?.status === 200, "the second stream opened");
  const stream = new Stream(response, late);
  const showing = showsEach(session, "lateviewer", stream);
  try {
    await until(() => stream.messages.length >= 1, "a first picture");
    assert.equal((await resize(session, 333)).status, 204);
    await until(() => showing(333), "the second stream to show the change");
  } finally {
    await Promise.all([stream.stop(), earlyOpened]);
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

test("input that waited behind a slow request for a tab that then closed is dropped alone, and what is typed for the next tab arrives", async () => {
  const other = await lab.worker("Second tab on a slow link");
  await other.act({ action: "open", url: lab.site.url("/a") });
  client = await chromium.launch();
  const page = await client.newPage({ viewport: { width: 1400, height: 900 } });
  const held: { route: Route | undefined } = { route: undefined };
  await page.route("**/api/input", async (route) => {
    if (held.route === undefined) held.route = route;
    else await route.continue();
  });
  await page.goto(viewer.url);
  await page.locator("#tabs li").nth(1).waitFor();
  await page
    .locator("#tabs li")
    .filter({ has: page.getByText(new RegExp(`^c-${String(worker.card.id)}( |$)`)) })
    .click();
  await until(async () => (await page.locator("#live").textContent()) === "live", "a live picture");

  const box = await page.locator("#screen").boundingBox();
  assert.ok(box !== null);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(() => held.route !== undefined, "the first request for input to be held");
  await page.keyboard.type("alpha");

  await worker.act({ action: "close" });
  await until(
    async () => (await page.locator("#tabs li").count()) === 1,
    "the closed tab to leave the list",
  );
  await until(async () => (await page.locator("#live").textContent()) === "live", "a live picture");
  await other.act({ action: "eval", expression: "document.getElementById('q').focus()" });
  await page.keyboard.type("bravo");

  assert.ok(held.route !== undefined);
  await held.route.continue();
  await until(
    async () =>
      JSON.parse(
        await other.act({ action: "eval", expression: "document.getElementById('q').value" }),
      ) === "bravo",
    "exactly the text typed for the second tab to reach it",
  );
});
