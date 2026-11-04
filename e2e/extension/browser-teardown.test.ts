import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { StandInChrome } from "../support/chrome.ts";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { TestSite } from "../support/site.ts";

let chrome: StandInChrome;
let site: TestSite;
let parts: DispatchLab;

beforeEach(async () => {
  chrome = await StandInChrome.start();
  site = await TestSite.start();
  parts = await startDispatchLab({
    carddArgs: ["--browser", JSON.stringify({ cdp: chrome.endpoint })],
  });
  parts.cardd.yolo("site");
});
afterEach(async () => {
  const stopped = await Promise.allSettled([stopDispatchLab(parts), chrome.stop(), site.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const dispatchStep = {
  title: "Look at the site",
  name: "look-at-site",
  kind: "ship",
  project: "site",
  intent: "Look at the page",
  host: "local",
  task: "open the page",
};

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("close closes the tab the worker opened and says so", async () => {
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "browser", args: { action: "open", url: site.url("/a") } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "looked" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("look at the site");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-1) ?? "", /^c-1 is done\..* Closed 1 browser tab\.$/);
  assert.equal((await chrome.pages()).length, 0);
});

test("restarting a worker closes the tab it had open", async () => {
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "restart_card", args: { card: 1, key: "again" } }), "mate");
  h.onModel(() => ({ text: "restarted" }), "mate");
  h.onModel(() => ({ tool: "browser", args: { action: "open", url: site.url("/a") } }), "worker");
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  h.onModel(() => ({ text: "started again" }), "worker");
  await connected(h);
  mate.prompt("look at the site");
  await eventually(async () => (await chrome.pages()).length === 1, "the worker's tab");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  mate.prompt("restart it");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-1) ?? "", /Started c-1-a1 again.* Closed 1 browser tab\.$/);
  assert.equal((await chrome.pages()).length, 0);
});
