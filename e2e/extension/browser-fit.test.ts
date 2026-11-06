import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Stream } from "../support/browser-herdr.ts";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { startViewer, type CaptainViewer } from "../support/captain-viewer.ts";
import { parseRecord, records } from "../support/json.ts";

const WAIT_MS = 15_000;

let lab: BrowserLab;
let worker: RawWorker;
const viewers: CaptainViewer[] = [];

beforeEach(async () => {
  lab = await BrowserLab.start({ gated: true });
  worker = await lab.worker("Sign in on a phone");
  await worker.act({ action: "open", url: lab.site.url("/a") });
});

afterEach(async () => {
  const stopped = await Promise.allSettled([
    ...viewers.splice(0).map((viewer) => viewer.stop()),
    lab.stop(),
  ]);
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
  const captain = await startViewer(lab, ["--captain"]);
  viewers.push(captain);
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
  const captain = await startViewer(lab, ["--captain"]);
  const gated = await startViewer(lab, []);
  viewers.push(captain, gated);
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
