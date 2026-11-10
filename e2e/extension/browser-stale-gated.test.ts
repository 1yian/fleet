import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { viewerBuild } from "@fleet/protocol/build";
import { chromium, type Browser as Client } from "playwright";
import { BrowserHerdr, until, type Worker } from "../support/browser-herdr.ts";
import { parseRecord } from "../support/json.ts";
import { pointInPicture } from "../support/viewer.ts";

let fleet: BrowserHerdr;
let client: Client | undefined;

afterEach(async (t) => {
  await client?.close();
  client = undefined;
  await fleet.stop(t);
});

const STALE = "http://127.0.0.1:9/?t=staletokenstaletokenstaletokenstale";
const OLD_BUILD = "0123456789ab";
const TYPED = "S3cr3t-typed-by-a-person";
const ENTERED_NOTE = "a password entered through the viewer is still in this page's form";
const ENTERED = new RegExp(ENTERED_NOTE);
const SAME_PAGE_AGAIN = "#again";

async function runOld(
  pane: string,
  mode: "captain" | "gated",
  build: string | undefined,
): Promise<void> {
  const printed = [
    `Fleet browser viewer (${mode}): ${STALE}`,
    ...(build === undefined ? [] : [`Viewer build: ${build}`]),
  ];
  await fleet.lab.submit(pane, `printf '${printed.join("\\n")}\\n'; sleep 600`);
  await until("the old viewer to be running", async () =>
    (await fleet.history(pane)).includes(STALE) ? true : undefined,
  );
}

async function replacedBy(workspace: string): Promise<string> {
  const pane = await fleet.viewerPane(workspace);
  await until("a viewer of the current build", async () =>
    (await fleet.history(pane)).split(STALE).at(-1)?.includes(`Viewer build: ${viewerBuild()}`)
      ? true
      : undefined,
  );
  const link = await fleet.viewerOf(workspace, "gated");
  assert.notEqual(link, STALE);
  return link;
}

async function pageSize(worker: Worker): Promise<{ width: number; height: number }> {
  const sent = await fleet.axi(worker, "eval '[innerWidth, innerHeight]'");
  const found = parseRecord(sent.text)["result"];
  if (!Array.isArray(found)) throw new Error(`the page size is not a pair: ${sent.text}`);
  return { width: Number(found[0]), height: Number(found[1]) };
}

for (const [build, what] of [
  [OLD_BUILD, "of an old build"],
  [undefined, "that prints no build"],
] as const) {
  test(`a gated viewer ${what} is replaced by the next open while nobody is signing in`, async () => {
    fleet = await BrowserHerdr.start({ browser: true });
    const [worker] = await fleet.workers(["Sign in to the portal"]);
    assert.ok(worker !== undefined);
    await runOld(await fleet.browserTab(worker.workspace), "gated", build);

    const opened = await fleet.axi(worker, `open ${fleet.site.url("/entry")}`);
    assert.equal(opened.code, 0, opened.text);
    assert.match(opened.text, /shows your tab live/);
    const link = await replacedBy(worker.workspace);
    assert.equal((await fleet.listingOf(link)).tabs.length, 1);
  });
}

test("a gated viewer of an old build is kept while a password that a person typed is in the form, and replaced once the page moves on", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker] = await fleet.workers(["Sign in to the portal"]);
  assert.ok(worker !== undefined);
  const entry = fleet.site.url("/entry");
  assert.equal((await fleet.axi(worker, `open ${entry}`)).code, 0);
  const first = await fleet.viewerOf(worker.workspace, "gated");

  client = await chromium.launch();
  const page = await client.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(first);
  await until("the picture to be live", async () =>
    (await page.locator("#live").textContent()) === "live" ? true : undefined,
  );
  const point = await pointInPicture(page, await pageSize(worker), 170, 86);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type(TYPED);
  await until("the typed password to be refused to the worker", async () => {
    const read = await fleet.axi(worker, `eval 'document.querySelector("input[name=p]").value'`);
    return read.text.includes(ENTERED_NOTE) ? true : undefined;
  });

  const pane = await fleet.viewerPane(worker.workspace);
  await fleet.lab.press(pane, "ctrl+c");
  await until("the first viewer to stop", async () =>
    (await fetch(first).then(
      () => false,
      () => true,
    ))
      ? true
      : undefined,
  );
  await runOld(pane, "gated", OLD_BUILD);

  const kept = await fleet.axi(worker, `open ${entry}${SAME_PAGE_AGAIN}`);
  assert.equal(kept.code, 0, kept.text);
  assert.match(kept.text, /already shows your tab/);
  assert.equal(await fleet.viewerOf(worker.workspace, "gated"), STALE);
  const refused = await fleet.axi(worker, `eval 'document.querySelector("input[name=p]").value'`);
  assert.match(refused.text, ENTERED);

  const moved = await fleet.axi(worker, `open ${fleet.site.url("/a")}`);
  assert.equal(moved.code, 0, moved.text);
  assert.match(moved.text, /shows your tab live/);
  await replacedBy(worker.workspace);
});

test("a gated placement leaves a viewer of the current build and a captain's viewer alone", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker, other] = await fleet.workers(["Sign in to the portal", "Read the docs"]);
  assert.ok(worker !== undefined && other !== undefined);
  assert.equal((await fleet.axi(worker, `open ${fleet.site.url("/a")}`)).code, 0);
  const current = await fleet.viewerOf(worker.workspace, "gated");
  const again = await fleet.axi(worker, `open ${fleet.site.url("/b")}`);
  assert.match(again.text, /already shows your tab/);
  assert.equal(await fleet.viewerOf(worker.workspace, "gated"), current);

  await runOld(await fleet.browserTab(other.workspace), "captain", OLD_BUILD);
  const left = await fleet.axi(other, `open ${fleet.site.url("/a")}`);
  assert.equal(left.code, 0, left.text);
  assert.match(left.text, /already shows your tab/);
  assert.equal(await fleet.viewerOf(other.workspace, "captain"), STALE);
});

test("a second mate's gated viewer of an old build is replaced when the captain is summoned to its lane", async () => {
  fleet = await BrowserHerdr.start({
    browser: true,
    hosts: { names: ["alpha", "beta"], mainHost: "alpha" },
  });
  await fleet.workers([], "beta");
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  fleet.h.onModel(() => ({ text: "told the captain too" }), "cnp");
  await fleet.startMain();
  const mate = await fleet.startMate("cnp", "Pay the vendor", "beta");
  assert.equal((await fleet.axi(mate.worker, `open ${fleet.site.url("/entry")}`)).code, 0);
  await runOld(await fleet.browserTab(mate.workspace), "gated", OLD_BUILD);
  await fleet.focus(mate.workspace);

  const summoned = await fleet.axi(mate.worker, "read --captain 'a one-time code'");
  assert.equal(summoned.code, 0, summoned.text);

  const link = await replacedBy(mate.workspace);
  assert.equal((await fleet.listingOf(link)).tabs.length, 1);
});
