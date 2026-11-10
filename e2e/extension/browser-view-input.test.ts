import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FIELD, ViewerPad } from "../support/viewer-pad.ts";
import { waitFor } from "../support/viewer.ts";

let rig: ViewerPad;

beforeEach(async () => {
  rig = await ViewerPad.start();
});
afterEach(async () => {
  await rig.stop();
});

test("dragging across the picture selects the page's text under the pointer", async () => {
  await rig.show(rig.captain);
  await rig.dragOver(3, 7);
  await waitFor(async () => (await rig.selected()) === "3456", "the dragged text to be selected");
});

test("hovering, right, middle, double and modified clicks reach the page as they are", async () => {
  const { page, pad } = rig;
  await rig.show(rig.captain);
  const at = await rig.picturePoint(140, 180);
  await page.mouse.move(at.x, at.y);
  await waitFor(
    async () =>
      (await rig.inPage(pad, "document.getElementById('box').matches(':hover')")) === true,
    "the page to see the pointer over the box",
  );
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.mouse.click(at.x, at.y, { button: "middle" });
  await page.mouse.dblclick(at.x, at.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Shift");
  await rig.sawAll(
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

test("moving the pointer off the picture ends the page's hover", async () => {
  const { page, pad } = rig;
  await rig.show(rig.captain);
  const over = async (): Promise<boolean> =>
    (await rig.inPage(pad, "document.getElementById('box').matches(':hover')")) === true;
  const at = await rig.picturePoint(140, 180);
  await page.mouse.move(at.x, at.y);
  await waitFor(over, "the page to see the pointer over the box");
  await page.mouse.move(100, 400);
  await waitFor(async () => !(await over()), "the page to see the pointer leave the box");
});

test("keys with modifiers arrive with their key, code and modifiers", async () => {
  const { page } = rig;
  await rig.show(rig.captain);
  await rig.clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.press("Control+Shift+KeyK");
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("F2");
  await rig.sawAll(
    [
      "keydown key=K code=KeyK ctrl+shift",
      "keyup key=K code=KeyK ctrl+shift",
      "keydown key=ArrowUp code=ArrowUp alt",
      "keydown key=F2 code=F2",
      "keyup key=F2 code=F2",
    ],
    "the page to see the modified keys",
  );
});

test("typing, keyboard selection and editing shortcuts change a field as they would in the page", async () => {
  const { page } = rig;
  await rig.show(rig.captain);
  await rig.clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.type("Hello, World!");
  await waitFor(async () => (await rig.fieldValue()) === "Hello, World!", "the text to be typed");

  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.type("abcdef");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("Z");
  await waitFor(async () => (await rig.fieldValue()) === "abcdZ", "the selection to be replaced");

  await page.keyboard.press("Home");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await waitFor(async () => (await rig.fieldValue()) === "bcd", "Home, Delete, End and Backspace");
});

test("a Mac's Cmd and Option shortcuts edit the field, since the page's own cannot", async () => {
  const { page } = rig;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await rig.show(rig.captain);
  await rig.clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.type("hello world");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.type("X");
  await waitFor(
    async () => (await rig.fieldValue()) === "hello Xworld",
    "Option+Left to move a word",
  );
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.type("Y");
  await waitFor(
    async () => (await rig.fieldValue()) === "Yhello Xworld",
    "Cmd+Left to reach the start",
  );
  await page.keyboard.press("Meta+KeyA");
  await page.keyboard.type("Q");
  await waitFor(async () => (await rig.fieldValue()) === "Q", "Cmd+A to select all");
  await page.keyboard.press("Meta+KeyZ");
  await waitFor(async () => (await rig.fieldValue()) !== "Q", "Cmd+Z to undo");
});

test("zoom, tab and developer tools shortcuts are left to the browser that shows the viewer", async () => {
  const { page } = rig;
  await rig.show(rig.captain);
  await rig.clickInPicture(FIELD.x, FIELD.y);
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.defineProperty(window, "heard", { value: heard });
    window.addEventListener("keydown", (event) => {
      if (!["Control", "Meta", "Shift"].includes(event.key))
        heard.push(`${event.key}:${String(event.defaultPrevented)}`);
    });
  });
  for (const shortcut of [
    "ControlOrMeta+KeyT",
    "ControlOrMeta+Equal",
    "ControlOrMeta+Minus",
    "ControlOrMeta+Digit0",
    "ControlOrMeta+Digit2",
    "F12",
    "ControlOrMeta+KeyK",
    "KeyZ",
  ])
    await page.keyboard.press(shortcut);
  await rig.sawAll(["keyup key=z code=KeyZ"], "the plain key to arrive");
  const heard = await page.evaluate((): string[] => {
    const found: unknown = Reflect.get(window, "heard");
    return Array.isArray(found) ? found.map(String) : [];
  });
  assert.deepEqual(heard, [
    "t:false",
    "=:false",
    "-:false",
    "0:false",
    "2:false",
    "F12:false",
    "k:true",
    "z:true",
  ]);
  const accelerator = process.platform === "darwin" ? "meta" : "ctrl";
  assert.deepEqual(
    (await rig.seen()).filter(
      (line) => line.startsWith("keydown") && !/key=(Control|Meta|Shift|Alt)/.test(line),
    ),
    [`keydown key=k code=KeyK ${accelerator}`, "keydown key=z code=KeyZ"],
  );
});

test("keys held on one tab are released there, last first, when the viewer moves to another tab", async () => {
  const { page, lab, pad } = rig;
  const other = await lab.worker("Second pad");
  await other.act({ action: "open", url: lab.site.url("/pad") });
  await rig.show(rig.captain, `c-${String(pad.card.id)} `);
  await page.keyboard.down("Shift");
  await page.keyboard.down("KeyZ");
  await rig.sawAll(["keydown key=Z code=KeyZ shift"], "the held keys to arrive");

  await page.locator("#tabs li", { hasText: `c-${String(other.card.id)} ` }).click();
  await rig.sawAll(["keyup key=Shift code=ShiftLeft"], "the first tab to get the releases");
  await waitFor(
    async () => (await page.locator("#live").textContent()) === "live",
    "the second tab to be shown",
  );
  await page.keyboard.up("KeyZ");
  await page.keyboard.up("Shift");
  await page.keyboard.type("q");
  await waitFor(
    async () => (await rig.seen(other)).includes("keyup key=q code=KeyQ"),
    "the second tab to get a later key",
  );
  assert.deepEqual(
    (await rig.seen(other)).filter((line) => /key=(Z|z|Shift)\b/.test(line)),
    [],
  );
  assert.deepEqual(
    (await rig.seen()).filter((line) => line.startsWith("keyup")),
    ["keyup key=Z code=KeyZ shift", "keyup key=Shift code=ShiftLeft"],
  );
});

test("composed text lands once it is committed, and no key is sent while composing", async () => {
  const { page, context } = rig;
  await rig.show(rig.captain);
  await rig.clickInPicture(FIELD.x, FIELD.y);
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
  await waitFor(async () => (await rig.fieldValue()) === "日本", "the committed text to land");
  assert.deepEqual(
    (await rig.seen()).filter((line) => line.startsWith("key")),
    [],
  );

  await page.keyboard.type("a");
  await waitFor(
    async () => (await rig.fieldValue()) === "日本a",
    "typing to go on after the commit",
  );
});
