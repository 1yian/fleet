import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BROWSER_OPS, check } from "@fleet/protocol";
import { BrowserLab, browse } from "../support/browser-lab.ts";
import { until } from "../support/login-fixtures.ts";

let lab: BrowserLab;

beforeEach(async () => {
  lab = await BrowserLab.start({ proxied: true });
});
afterEach(async () => {
  await lab.stop();
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const pathsOpen = async (): Promise<string[]> =>
  (await lab.chrome.pages()).map((page) => new URL(page.url).pathname);

const isStopped = (entry: { kind: string; fields: Record<string, unknown> }): boolean =>
  entry.kind === "report" && entry.fields["status"] === "stopped";

async function runAndStop(): Promise<{ release: () => void }> {
  const held = gate();
  const worker = await lab.crew("Look at the page");
  browse(worker.h, { action: "open", url: lab.site.url("/a") });
  worker.h.onModel(async () => {
    await held.wait;
    return { text: "too late" };
  });
  await worker.h.waitForCall(1);
  assert.deepEqual(await pathsOpen(), ["/a"]);
  worker.pi.abort();
  return { release: held.open };
}

test("stopping a worker's run from the pane closes its tab", async () => {
  const { release } = await runAndStop();
  await lab.main.waitForEntry(isStopped, "the stopped report");
  await until(
    async () => ((await pathsOpen()).length === 0 ? true : undefined),
    "the tab to close",
  );
  release();
});

test("a tab of a run that was stopped while the browser was down is closed once it is back", async () => {
  const proxy = lab.proxy;
  assert.ok(proxy !== undefined);
  const held = gate();
  const worker = await lab.crew("Look at the page");
  browse(worker.h, { action: "open", url: lab.site.url("/a") });
  worker.h.onModel(async () => {
    await held.wait;
    return { text: "too late" };
  });
  await worker.h.waitForCall(1);
  await proxy.stop();
  worker.pi.abort();
  await lab.main.waitForEntry(isStopped, "the stopped report");
  assert.deepEqual(await pathsOpen(), ["/a"]);

  await proxy.listen();
  await until(async () => {
    check(BROWSER_OPS["browser.view"].result, await lab.main.call("browser.view", {}));
    return (await pathsOpen()).length === 0 ? true : undefined;
  }, "a viewer poll to close the retired tab");
  held.open();
});

const pathsOf = async (): Promise<string[]> =>
  (await lab.chrome.pages()).map((page) => new URL(page.url).pathname);

test("a stopped report that was committed but never released closes the tab when the browser is polled after a restart", async () => {
  const worker = await lab.worker("Look at the page");
  await worker.act({ action: "open", url: lab.site.url("/a") });
  lab.cardd.commitStoppedReport(worker.card.id);
  await lab.cardd.restart();
  const main = await lab.cardd.connect(lab.mainToken);
  try {
    assert.deepEqual(await pathsOf(), ["/a"]);
    await until(async () => {
      check(BROWSER_OPS["browser.view"].result, await main.call("browser.view", {}));
      return (await pathsOf()).length === 0 ? true : undefined;
    }, "a viewer poll to close the stopped run's tab");

    const resumed = await lab.reconnect(worker);
    assert.match(await resumed.act({ action: "open", url: lab.site.url("/b") }), /Bravo/);
    assert.deepEqual(await pathsOf(), ["/b"]);
  } finally {
    await main.close();
  }
});

test("a card that was resumed after the stop keeps its tab, whatever the viewer polls", async () => {
  const worker = await lab.worker("Look at the page");
  await worker.act({ action: "open", url: lab.site.url("/a") });
  lab.cardd.commitStoppedReport(worker.card.id);
  await lab.cardd.restart();
  const main = await lab.cardd.connect(lab.mainToken);
  try {
    const resumed = await lab.reconnect(worker);
    resumed.session.send({ t: "activity", state: "running" });
    assert.match(await resumed.act({ action: "read" }), /alpha page/);
    for (let poll = 0; poll < 3; poll += 1)
      check(BROWSER_OPS["browser.view"].result, await main.call("browser.view", {}));
    assert.deepEqual(await pathsOf(), ["/a"]);
    assert.match(await resumed.act({ action: "read" }), /alpha page/);
  } finally {
    await main.close();
  }
});
