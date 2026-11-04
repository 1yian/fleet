import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { StandInChrome } from "../support/chrome.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let chrome: StandInChrome;
let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;

async function setup(browser: boolean): Promise<void> {
  chrome = await StandInChrome.start();
  cardd = await Cardd.start(
    {},
    browser ? ["--browser", JSON.stringify({ cdp: chrome.endpoint })] : [],
  );
  h = await Harness.start();
  scratch = new Scratch();
  configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_BROWSER_VIEW_OPEN: "0",
  });
}

afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop(), chrome.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function tabsOfMain(pane: string): Promise<{ label: string; pane: string }[]> {
  const panes = records((await lab.run(["pane", "list"]))["panes"]);
  const workspace = panes.find((each) => each["pane_id"] === pane)?.["workspace_id"];
  const tabs = records((await lab.run(["tab", "list", "--workspace", String(workspace)]))["tabs"]);
  return tabs.map((tab) => ({
    label: String(tab["label"]),
    pane: String(
      panes.find(
        (each) => each["tab_id"] === tab["tab_id"] && each["workspace_id"] === workspace,
      )?.["pane_id"],
    ),
  }));
}

async function until<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("main's workspace gets a Browser tab that runs the viewer", async () => {
  await setup(true);
  const pane = await startMain(lab, scratch, h);
  const tab = await until("the Browser tab", async () =>
    (await tabsOfMain(pane)).find((each) => each.label === "Browser"),
  );
  const address = await until(
    "the viewer's address",
    async () =>
      /Fleet browser viewer: (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/.exec(
        await lab.history(tab.pane),
      )?.[1],
  );
  const bare = new URL(address);
  bare.search = "";
  assert.equal((await fetch(bare)).status, 403);
  const entered = await fetch(address, { redirect: "manual" });
  assert.equal(entered.status, 302);
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.match(cookie, /^fleet_viewer=/);
  const served = await fetch(bare, { headers: { cookie } });
  assert.equal(served.status, 200);
  assert.match(await served.text(), /<title>Fleet browser<\/title>/);
  assert.deepEqual(
    (await tabsOfMain(pane)).map((each) => each.label).filter((label) => label === "Browser"),
    ["Browser"],
  );
});

test("a fleet with no shared browser gets no Browser tab", async () => {
  await setup(false);
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.deepEqual(
    (await tabsOfMain(pane)).map((each) => each.label).filter((label) => label === "Browser"),
    [],
  );
});
