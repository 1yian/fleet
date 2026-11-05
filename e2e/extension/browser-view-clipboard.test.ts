import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  assertNoSecretAnywhere as scan,
  clearedByHand,
  PASSWORD,
  signedIn,
  tabOf,
  USERNAME,
} from "../support/login-fixtures.ts";
import { FIELD, ViewerPad } from "../support/viewer-pad.ts";
import { launchViewer, waitFor } from "../support/viewer.ts";

let rig: ViewerPad;

beforeEach(async () => {
  rig = await ViewerPad.start();
});
afterEach(async () => {
  await rig.stop();
});

test("pasting puts the clipboard's text into the page", async () => {
  await rig.show(rig.captain);
  await rig.clickInPicture(FIELD.x, FIELD.y);
  await rig.setClipboard("pasted ✓ text");
  await rig.page.keyboard.press("ControlOrMeta+KeyV");
  await waitFor(
    async () => (await rig.fieldValue()) === "pasted ✓ text",
    "the pasted text to land",
  );
});

test("copy writes the page's selection to the clipboard", async () => {
  const { page } = rig;
  await rig.show(rig.captain);
  await rig.setClipboard("before");
  await rig.dragOver(3, 7);
  await waitFor(async () => (await rig.selected()) === "3456", "the dragged text to be selected");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () => (await rig.clipboard()) === "3456",
    "the selection to reach the clipboard",
  );
  assert.equal(await page.locator("#copied").textContent(), "copied 4 characters");
  assert.deepEqual(await rig.clipboardEvents(), []);

  await rig.setClipboard("kept");
  await rig.clickInPicture(FIELD.x, FIELD.y);
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () => (await page.locator("#copied").textContent()) === "nothing is selected",
    "a copy with nothing selected to be told so",
  );
  assert.equal(await page.locator("#copied").getAttribute("class"), "empty");
  assert.equal(await rig.clipboard(), "kept");
});

test("a gated viewer copies through cardd, and refuses on a tab with a login-filled value", async () => {
  const { page, lab, vault, viewers } = rig;
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

  await rig.show(gated, "users-edit-text");
  await rig.setClipboard("before");
  await rig.dragOver(3, 7);
  await waitFor(async () => (await rig.selected()) === "3456", "the dragged text to be selected");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () => (await rig.clipboard()) === "3456",
    "the selection to reach the clipboard",
  );

  await rig.show(gated, label, "hidden");
  await rig.setClipboard("kept");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () =>
      (await page.locator("#copied").innerText()).startsWith(
        "nothing was copied: a stored credential",
      ),
    "the copy to be refused",
  );
  assert.equal(await page.locator("#copied").getAttribute("class"), "failed");
  assert.equal(await rig.clipboard(), "kept");

  await rig.show(rig.captain, label);
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () => (await rig.clipboard()) === USERNAME,
    "the captain's copy to read the page",
  );
  scan(lab, vault);
});

test("a gated copy hides a stored value that the page shows once its form is empty", async () => {
  const { page, lab, vault, viewers } = rig;
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

  await rig.show(gated, label, "hidden");
  await rig.setClipboard("kept");
  await page.keyboard.press("ControlOrMeta+KeyC");
  await waitFor(
    async () => (await rig.clipboard()) === "[hidden]",
    "the cleaned text to be copied",
  );
  assert.equal(await page.locator("#copied").textContent(), "copied 8 characters");
  scan(lab, vault);
});

test("a gated viewer's middle click pastes nothing, so a login-filled value cannot be carried into a page", async () => {
  const { page, lab, vault, viewers } = rig;
  const worker = await signedIn(lab, "/portal");
  const label = `c-${String(worker.card.id)} `;
  const portalTab = (await lab.chrome.pages()).find((tab) => tab.title.startsWith(label));
  assert.ok(portalTab !== undefined);
  const gated = await launchViewer(lab, viewers, []);

  await rig.show(gated, label, "hidden");
  await page.keyboard.press("ControlOrMeta+KeyA");
  await waitFor(
    async () =>
      (await lab.chrome.evaluate(portalTab.id, "getSelection().toString().length")) ===
      PASSWORD.length,
    "the stored password to be selected in its field",
  );

  await worker.act({ action: "open", url: lab.site.url("/pad") });
  await rig.show(gated, label);
  const field = await rig.picturePoint(FIELD.x, FIELD.y, worker);
  await page.mouse.click(field.x, field.y, { button: "middle" });
  await page.mouse.click(field.x, field.y);
  await page.keyboard.type("q");
  await waitFor(
    async () => (await rig.seen(worker)).includes("keyup key=q code=KeyQ"),
    "the later key to arrive after the middle click",
  );
  assert.equal(await rig.inPage(worker, "document.getElementById('field').value.length"), 1);
  assert.deepEqual(
    (await rig.seen(worker)).filter((line) => line === "paste"),
    [],
  );
  scan(lab, vault);
});

test("no key sent to the viewer makes the tab's own Chrome copy, cut or paste", async () => {
  const { page, lab, pad } = rig;
  await rig.show(rig.captain);
  const target = await tabOf(lab, pad);
  await rig.dragOver(3, 7);
  await waitFor(async () => (await rig.selected()) === "3456", "the dragged text to be selected");
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
  await rig.sawAll(["keydown key=z code=KeyZ"], "the plain key to arrive after the others");
  assert.deepEqual(await rig.clipboardEvents(), []);
  assert.deepEqual(
    (await rig.seen()).filter((line) => !line.startsWith("keydown key=z")),
    [],
  );
});
