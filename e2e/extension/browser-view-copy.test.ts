import assert from "node:assert/strict";
import { chromium, type Browser as Client, type Page } from "playwright";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import { isRecord } from "../support/json.ts";
import { GOOD } from "../support/login-fixtures.ts";
import {
  launchViewer,
  pointInPicture,
  showTab,
  stopViewers,
  waitFor,
  type Viewers,
} from "../support/viewer.ts";

let vault: FakeVault;
let lab: BrowserLab;
let client: Client;
let page: Page;
let worker: RawWorker;
const viewers: Viewers = [];

beforeEach(() => {
  vault = new FakeVault([]);
  vault.publish([GOOD]);
});
afterEach(async () => {
  const stopped = await Promise.allSettled([...stopViewers(viewers), client.close(), lab.stop()]);
  vault.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function inPage(expression: string): Promise<unknown> {
  const tab = (await lab.chrome.pages()).find((each) =>
    each.title.startsWith(`c-${String(worker.card.id)} `),
  );
  if (tab === undefined) throw new Error("the card has no tab");
  return lab.chrome.evaluate(tab.id, expression);
}

async function start(isolated = false): Promise<void> {
  lab = await BrowserLab.start({ vault, isolated });
  worker = await lab.worker("Embedded words");
  const inner = lab.site.url("/words", "inner.example.test");
  await worker.act({ action: "open", url: `${lab.site.url("/framed")}#${inner}` });
  await waitFor(async () => (await inPage("window.loaded")) === true, "the framed page to load");
  client = await chromium.launch();
  const context = await client.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
}

async function emptyFramedPassword(): Promise<void> {
  const frame = (await lab.chrome.targets()).find((each) => each.type === "iframe");
  if (frame === undefined) throw new Error("the framed page has no target");
  await lab.chrome.evaluate(frame.id, "document.getElementById('vaulted').value = ''");
}

async function pointOnPage(x: number, y: number): Promise<{ x: number; y: number }> {
  const size = await inPage("({ width: innerWidth, height: innerHeight })");
  assert.ok(isRecord(size));
  return pointInPicture(
    page,
    { width: Number(size["width"]), height: Number(size["height"]) },
    x,
    y,
  );
}

const IN_FRAME = { x: 20, y: 20 };
const FIELD = { x: 200, y: 176 };
const FIELD_VALUE = "document.getElementById('field').value";

async function clickField(): Promise<void> {
  const at = await pointOnPage(FIELD.x, FIELD.y);
  await page.mouse.click(at.x, at.y);
}

const clipboard = (): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (text: string): Promise<void> =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

test("cut does nothing: the field and the clipboard stay as they were", async () => {
  await start();
  await showTab(page, await launchViewer(lab, viewers, ["--captain"]));
  await clickField();
  await page.keyboard.type("keep me");
  await waitFor(async () => (await inPage(FIELD_VALUE)) === "keep me", "the text to be typed");
  await page.keyboard.press("ControlOrMeta+KeyA");
  await setClipboard("kept");
  await page.keyboard.press("ControlOrMeta+KeyX");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await waitFor(
    async () => (await inPage(FIELD_VALUE)) === "keep me!",
    "typing to go on after cut",
  );
  assert.equal(await clipboard(), "kept");
  assert.equal(await page.locator("#copied").textContent(), "");
  const seen = await inPage("window.seen");
  assert.ok(Array.isArray(seen));
  assert.deepEqual(
    seen.filter((line) => /^(keydown|keyup) x$|^(copy|cut|paste)$/i.test(String(line))),
    [],
  );
});

test("copy reads the selection as it was when it was asked for, before the keys typed after it", async () => {
  await start();
  await showTab(page, await launchViewer(lab, viewers, ["--captain"]));
  await clickField();
  await page.keyboard.type("copy me");
  await page.keyboard.press("ControlOrMeta+KeyA");
  await waitFor(
    async () => (await inPage("getSelection().toString()")) === "copy me",
    "the text to be selected",
  );
  await setClipboard("kept");

  const sent: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/copy") sent.push("copy");
    if (path !== "/api/input") return;
    const body: unknown = JSON.parse(request.postData() ?? "null");
    for (const each of Array.isArray(body) ? body : [body])
      if (isRecord(each))
        sent.push([each["kind"], each["action"], each["key"]].filter(Boolean).join(" "));
  });
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/input", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    const away = await pointOnPage(300, 300);
    await page.mouse.move(away.x, away.y);
    await page.keyboard.press("ControlOrMeta+KeyC");
    await page.keyboard.type("z");
  } finally {
    release();
  }
  await waitFor(async () => (await inPage(FIELD_VALUE)) === "z", "the typed letter to replace it");
  assert.equal(await clipboard(), "copy me");
  const accelerator = process.platform === "darwin" ? "Meta" : "Control";
  assert.deepEqual(sent.slice(sent.indexOf("mouse move")), [
    "mouse move",
    `key down ${accelerator}`,
    "copy",
    `key up ${accelerator}`,
    "key down z",
    "key up z",
  ]);
});

for (const isolated of [false, true]) {
  test(`copy reads a selection inside a cross-origin iframe, ${isolated ? "out of process" : "in process"}`, async () => {
    await start(isolated);
    const shown: [string, string | undefined][] = [
      [await launchViewer(lab, viewers, ["--captain"]), undefined],
    ];
    if (isolated) shown.push([await launchViewer(lab, viewers, []), "embedded-words"]);
    for (const [address, label] of shown) {
      if (label !== undefined) await emptyFramedPassword();
      await showTab(page, address, label);
      await setClipboard("before");
      const word = await pointOnPage(IN_FRAME.x + 60, IN_FRAME.y + 14);
      await page.mouse.dblclick(word.x, word.y);
      await page.keyboard.press("ControlOrMeta+KeyC");
      await waitFor(
        async () => (await page.locator("#copied").textContent()) === "copied 10 characters",
        "the framed word to be copied",
      );
      assert.equal(await clipboard(), "selectable");

      for (const spot of [
        { x: 300, y: 100, all: false },
        { x: 30, y: 75, all: true },
      ]) {
        await inPage("(getSelection().selectAllChildren(document.getElementById('parent')), true)");
        const at = await pointOnPage(IN_FRAME.x + spot.x, IN_FRAME.y + spot.y);
        await page.mouse.click(at.x, at.y);
        if (spot.all) await page.keyboard.press("ControlOrMeta+KeyA");
        assert.equal(await inPage("getSelection().toString()"), "parent words");
        await setClipboard("kept");
        await page.locator("#copied").evaluate((status) => {
          status.textContent = "";
        });
        await page.keyboard.press("ControlOrMeta+KeyC");
        await waitFor(
          async () => (await page.locator("#copied").textContent()) === "nothing is selected",
          "an empty or password selection in the frame to give nothing",
        );
        assert.equal(await clipboard(), "kept");
      }
    }
  });
}
