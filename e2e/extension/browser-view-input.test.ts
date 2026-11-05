import assert from "node:assert/strict";
import { chromium, type Browser as Client, type BrowserContext, type Page } from "playwright";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import { isRecord } from "../support/json.ts";
import {
  assertNoSecretAnywhere as scan,
  clearedByHand,
  GOOD,
  signedIn,
  tabOf,
  USERNAME,
} from "../support/login-fixtures.ts";
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
let context: BrowserContext;
let page: Page;
let pad: RawWorker;
let captain: string;
const viewers: Viewers = [];

beforeEach(async () => {
  vault = new FakeVault([]);
  vault.publish([GOOD]);
  lab = await BrowserLab.start({ vault });
  pad = await lab.worker("Users edit text");
  await pad.act({ action: "open", url: lab.site.url("/pad") });
  captain = await launchViewer(lab, viewers, ["--captain"]);
  client = await chromium.launch();
  context = await client.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
});
afterEach(async () => {
  const stopped = await Promise.allSettled([...stopViewers(viewers), client.close(), lab.stop()]);
  vault.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const show = (address: string, label?: string, state?: string): Promise<void> =>
  showTab(page, address, label, state);

async function inPage(who: RawWorker, expression: string): Promise<unknown> {
  return JSON.parse(await who.act({ action: "eval", expression }));
}

const seen = async (who: RawWorker = pad): Promise<string[]> => {
  const lines = await inPage(who, "window.seen");
  assert.ok(Array.isArray(lines) && lines.every((line) => typeof line === "string"));
  return lines.map(String);
};

async function sawAll(wanted: string[], what: string): Promise<void> {
  await waitFor(async () => {
    const lines = await seen();
    return wanted.every((start) => lines.some((line) => line.startsWith(start)));
  }, what);
}

async function numbers(who: RawWorker, expression: string): Promise<Record<string, number>> {
  const found = await inPage(who, expression);
  assert.ok(isRecord(found));
  return Object.fromEntries(Object.entries(found).map(([name, value]) => [name, Number(value)]));
}

async function picturePoint(x: number, y: number): Promise<{ x: number; y: number }> {
  const size = await numbers(pad, "({ width: innerWidth, height: innerHeight })");
  return pointInPicture(page, { width: size["width"] ?? 1, height: size["height"] ?? 1 }, x, y);
}

async function clickInPicture(x: number, y: number): Promise<void> {
  const at = await picturePoint(x, y);
  await page.mouse.click(at.x, at.y);
}

const FIELD = { x: 200, y: 96 };
const fieldValue = (): Promise<unknown> => inPage(pad, "document.getElementById('field').value");

const TEXT_RECT = (from: number, to: number): string => `(() => {
  const text = document.getElementById("line").firstChild;
  const range = document.createRange();
  range.setStart(text, ${String(from)});
  range.setEnd(text, ${String(to)});
  const box = range.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
})()`;

async function dragOver(from: number, to: number): Promise<void> {
  const box = await numbers(pad, TEXT_RECT(from, to));
  const middle = ((box["top"] ?? 0) + (box["bottom"] ?? 0)) / 2;
  const start = await picturePoint((box["left"] ?? 0) + 1, middle);
  const end = await picturePoint((box["right"] ?? 0) - 1, middle);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

const clipboardEvents = async (): Promise<string[]> =>
  (await seen()).filter((line) => ["copy", "cut", "paste"].includes(line));

const selected = (): Promise<unknown> => inPage(pad, "getSelection().toString()");
const clipboard = (): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (text: string): Promise<void> =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

test("dragging across the picture selects the page's text under the pointer", async () => {
  await show(captain);
  await dragOver(3, 7);
  await waitFor(async () => (await selected()) === "3456", "the dragged text to be selected");
});

test("hovering, right, middle, double and modified clicks reach the page as they are", async () => {
  await show(captain);
  const at = await picturePoint(140, 180);
  await page.mouse.move(at.x, at.y);
  await waitFor(
    async () => (await inPage(pad, "document.getElementById('box').matches(':hover')")) === true,
    "the page to see the pointer over the box",
  );
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.mouse.click(at.x, at.y, { button: "middle" });
  await page.mouse.dblclick(at.x, at.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Shift");
  await sawAll(
    [
      "mouseover",
      "mousedown button=2",
      "mouseup button=2",
      "contextmenu button=2",
      "auxclick button=1",
      "click button=0 detail=2",
      "dblclick button=0",
      "click button=0 detail=1 shift",
    ],
    "the page to see every kind of click",
  );
});

test("keys with modifiers arrive with their key, code and modifiers", async () => {
  await show(captain);
  await clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.press("Control+Shift+KeyK");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("F2");
  await sawAll(
    [
      "keydown key=K code=KeyK ctrl+shift",
      "keyup key=K code=KeyK ctrl+shift",
      "keydown key=ArrowLeft code=ArrowLeft alt",
      "keydown key=F2 code=F2",
      "keyup key=F2 code=F2",
    ],
    "the page to see the modified keys",
  );
});

test("typing, keyboard selection and editing shortcuts change a field as they would in the page", async () => {
  await show(captain);
  await clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.type("Hello, World!");
  await waitFor(async () => (await fieldValue()) === "Hello, World!", "the text to be typed");

  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.type("abcdef");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("Z");
  await waitFor(async () => (await fieldValue()) === "abcdZ", "the selection to be replaced");

  await page.keyboard.press("Home");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await waitFor(async () => (await fieldValue()) === "bcd", "Home, Delete, End and Backspace");
});

test("a Mac's Cmd and Option shortcuts edit the field, since the page's own cannot", async () => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await show(captain);
  await clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.type("hello world");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.type("X");
  await waitFor(async () => (await fieldValue()) === "hello Xworld", "Option+Left to move a word");
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.type("Y");
  await waitFor(
    async () => (await fieldValue()) === "Yhello Xworld",
    "Cmd+Left to reach the start",
  );
  await page.keyboard.press("Meta+KeyA");
  await page.keyboard.type("Q");
  await waitFor(async () => (await fieldValue()) === "Q", "Cmd+A to select all");
  await page.keyboard.press("Meta+KeyZ");
  await waitFor(async () => (await fieldValue()) !== "Q", "Cmd+Z to undo");
});

test("reload, zoom, tab and developer tools shortcuts are left to the browser that shows the viewer", async () => {
  await show(captain);
  await clickInPicture(FIELD.x, FIELD.y);
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.defineProperty(window, "heard", { value: heard });
    window.addEventListener("keydown", (event) => {
      if (!["Control", "Meta", "Shift"].includes(event.key))
        heard.push(`${event.key}:${String(event.defaultPrevented)}`);
    });
  });
  for (const shortcut of [
    "ControlOrMeta+KeyR",
    "ControlOrMeta+Shift+KeyR",
    "ControlOrMeta+KeyT",
    "ControlOrMeta+Equal",
    "ControlOrMeta+Minus",
    "ControlOrMeta+Digit0",
    "ControlOrMeta+Digit2",
    "F5",
    "F12",
    "ControlOrMeta+KeyK",
    "KeyZ",
  ])
    await page.keyboard.press(shortcut);
  await sawAll(["keyup key=z code=KeyZ"], "the plain key to arrive");
  const heard = await page.evaluate((): string[] => {
    const found: unknown = Reflect.get(window, "heard");
    return Array.isArray(found) ? found.map(String) : [];
  });
  assert.deepEqual(heard, [
    "r:false",
    "R:false",
    "t:false",
    "=:false",
    "-:false",
    "0:false",
    "2:false",
    "F5:false",
    "F12:false",
    "k:true",
    "z:true",
  ]);
  const accelerator = process.platform === "darwin" ? "meta" : "ctrl";
  assert.deepEqual(
    (await seen()).filter(
      (line) => line.startsWith("keydown") && !/key=(Control|Meta|Shift|Alt)/.test(line),
    ),
    [`keydown key=k code=KeyK ${accelerator}`, "keydown key=z code=KeyZ"],
  );
});

test("keys held on one tab are released there, last first, when the viewer moves to another tab", async () => {
  const other = await lab.worker("Second pad");
  await other.act({ action: "open", url: lab.site.url("/pad") });
  await show(captain, `c-${String(pad.card.id)} `);
  await page.keyboard.down("Shift");
  await page.keyboard.down("KeyZ");
  await sawAll(["keydown key=Z code=KeyZ shift"], "the held keys to arrive");

  await page.locator("#tabs li", { hasText: `c-${String(other.card.id)} ` }).click();
  await sawAll(["keyup key=Shift code=ShiftLeft"], "the first tab to get the releases");
  await waitFor(
    async () => (await page.locator("#live").textContent()) === "live",
    "the second tab to be shown",
  );
  await page.keyboard.up("KeyZ");
  await page.keyboard.up("Shift");
  await page.keyboard.type("q");
  await waitFor(
    async () => (await seen(other)).includes("keyup key=q code=KeyQ"),
    "the second tab to get a later key",
  );
  assert.deepEqual(
    (await seen(other)).filter((line) => /key=(Z|z|Shift)\b/.test(line)),
    [],
  );
  assert.deepEqual(
    (await seen()).filter((line) => line.startsWith("keyup")),
    ["keyup key=Z code=KeyZ shift", "keyup key=Shift code=ShiftLeft"],
  );
});

test("composed text lands once it is committed, and no key is sent while composing", async () => {
  await show(captain);
  await clickInPicture(FIELD.x, FIELD.y);
  const ime = await context.newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await page.evaluate(() => {
    const capture = document.getElementById("capture");
    for (const type of ["keydown", "keyup"])
      capture?.dispatchEvent(
        new KeyboardEvent(type, { key: "n", code: "KeyN", keyCode: 229, isComposing: true }),
      );
  });
  await ime.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
  await page.keyboard.press("Enter");

  await ime.send("Input.insertText", { text: "日本" });
  await waitFor(async () => (await fieldValue()) === "日本", "the committed text to land");
  assert.deepEqual(
    (await seen()).filter((line) => line.startsWith("key")),
    [],
  );

  await page.keyboard.type("a");
  await waitFor(async () => (await fieldValue()) === "日本a", "typing to go on after the commit");
});

test("pasting puts the clipboard's text into the page", async () => {
  await show(captain);
  await clickInPicture(FIELD.x, FIELD.y);
  await setClipboard("pasted ✓ text");
  await page.keyboard.press("ControlOrMeta+KeyV");
  await waitFor(async () => (await fieldValue()) === "pasted ✓ text", "the pasted text to land");
});

test("copy writes the page's selection to the clipboard", async () => {
  await show(captain);
  await setClipboard("before");
  await dragOver(3, 7);
  await waitFor(async () => (await selected()) === "3456", "the dragged text to be selected");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(async () => (await clipboard()) === "3456", "the selection to reach the clipboard");
  assert.equal(await page.locator("#copied").textContent(), "copied 4 characters");
  assert.deepEqual(await clipboardEvents(), []);

  await setClipboard("kept");
  await clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () => (await page.locator("#copied").textContent()) === "nothing is selected",
    "a copy with nothing selected to be told so",
  );
  assert.equal(await page.locator("#copied").getAttribute("class"), "empty");
  assert.equal(await clipboard(), "kept");
});

test("a gated viewer copies through cardd, and refuses on a tab with a login-filled value", async () => {
  const portal = await signedIn(lab, "/portal");
  const label = `c-${String(portal.card.id)} `;
  const portalTab = (await lab.chrome.pages()).find((tab) => tab.title.startsWith(label));
  assert.ok(portalTab !== undefined);
  await lab.chrome.evaluate(
    portalTab.id,
    "getSelection().selectAllChildren(document.getElementById('u-echo'))",
  );
  assert.equal(await lab.chrome.evaluate(portalTab.id, "getSelection().toString()"), USERNAME);
  const gated = await launchViewer(lab, viewers, []);

  await show(gated, "users-edit-text");
  await setClipboard("before");
  await dragOver(3, 7);
  await waitFor(async () => (await selected()) === "3456", "the dragged text to be selected");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(async () => (await clipboard()) === "3456", "the selection to reach the clipboard");

  await show(gated, label, "hidden");
  await setClipboard("kept");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () =>
      (await page.locator("#copied").innerText()).startsWith(
        "nothing was copied: a stored credential",
      ),
    "the copy to be refused",
  );
  assert.equal(await page.locator("#copied").getAttribute("class"), "failed");
  assert.equal(await clipboard(), "kept");

  await show(captain, label);
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () => (await clipboard()) === USERNAME,
    "the captain's copy to read the page",
  );
  scan(lab, vault);
});

test("a gated copy hides a stored value that the page shows once its form is empty", async () => {
  const echo = await signedIn(lab, "/echo");
  await clearedByHand(lab, echo);
  const label = `c-${String(echo.card.id)} `;
  const echoTab = (await lab.chrome.pages()).find((tab) => tab.title.startsWith(label));
  assert.ok(echoTab !== undefined);
  await lab.chrome.evaluate(
    echoTab.id,
    "getSelection().selectAllChildren(document.getElementById('u-echo'))",
  );
  assert.equal(await lab.chrome.evaluate(echoTab.id, "getSelection().toString()"), USERNAME);
  const gated = await launchViewer(lab, viewers, []);

  await show(gated, label, "hidden");
  await setClipboard("kept");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(async () => (await clipboard()) === "[hidden]", "the cleaned text to be copied");
  assert.equal(await page.locator("#copied").textContent(), "copied 8 characters");
  scan(lab, vault);
});

test("no key sent to the viewer makes the tab's own Chrome copy, cut or paste", async () => {
  await show(captain);
  const target = await tabOf(lab, pad);
  await dragOver(3, 7);
  await waitFor(async () => (await selected()) === "3456", "the dragged text to be selected");
  const post = (body: object): Promise<number> =>
    page.evaluate(
      async (payload) =>
        (
          await fetch("/api/input", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        ).status,
      body,
    );
  const key = (
    modifiers: number,
    name: string,
    code: string,
    keyCode = 0,
    commands: string[] = [],
  ): object => ({
    target,
    kind: "key",
    action: "down",
    key: name,
    code,
    keyCode,
    location: 0,
    repeat: false,
    modifiers,
    commands,
  });
  for (const [modifiers, name, code, keyCode] of [
    [2, "c", "KeyC", 0],
    [4, "c", "KeyC", 0],
    [6, "X", "KeyX", 0],
    [2, "v", "KeyV", 0],
    [2, "Insert", "Insert", 0],
    [8, "Insert", "Insert", 0],
    [8, "Delete", "Delete", 0],
    [2, "q", "KeyQ", 67],
    [4, "q", "KeyQ", 88],
    [2, "q", "KeyQ", 86],
    [4, "q", "KeyQ", 45],
    [8, "q", "KeyQ", 45],
    [8, "q", "KeyQ", 46],
    [2, "Insert", "KeyQ", 0],
    [8, "Delete", "KeyQ", 0],
  ] as const)
    assert.equal(
      await post(key(modifiers, name, code, keyCode)),
      204,
      `${name} ${code} ${String(keyCode)} with ${String(modifiers)}`,
    );
  for (const command of ["copy", "cut", "paste"])
    assert.equal(await post(key(2, "q", "KeyQ", 0, [command])), 502, `the command ${command}`);
  assert.equal(await post(key(0, "z", "KeyZ")), 204);
  await sawAll(["keydown key=z code=KeyZ"], "the plain key to arrive after the others");
  assert.deepEqual(await clipboardEvents(), []);
  assert.deepEqual(
    (await seen()).filter((line) => !line.startsWith("keydown key=z")),
    [],
  );
});
