import assert from "node:assert/strict";
import { test } from "node:test";
import { boundBoardFile } from "../support/board.ts";
import {
  clickAndSettle,
  launch,
  nextFrames,
  screenClick,
  takeControl,
  until,
} from "../support/browser-lab.ts";

boundBoardFile();

test("a key held when only the stream drops is released once the same tab is confirmed again", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await screenClick(page);
  await page.keyboard.down("Shift");
  await until(() => endpoint.order.includes("key:rawKeyDown:Shift"));
  const opens = endpoint.streamOpens;
  endpoint.startOutage();
  await page.getByText("Browser connection interrupted").waitFor();
  endpoint.withholdState();
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  endpoint.hold();
  endpoint.releaseState();
  await until(() => endpoint.order.includes("key:keyUp:Shift"));
  assert.equal(await page.getByText("You’re in control").count(), 0);
  endpoint.release();
  await page.getByText("You’re in control").waitFor();
  const pressed = endpoint.order.indexOf("key:rawKeyDown:Shift");
  assert.deepEqual(endpoint.order.slice(pressed), ["key:rawKeyDown:Shift", "key:keyUp:Shift"]);
  await page.keyboard.up("Shift");
});

test("leaving before a reconnected stream is confirmed sends no release for a held key", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await screenClick(page);
  await page.keyboard.down("Shift");
  await until(() => endpoint.order.includes("key:rawKeyDown:Shift"));
  const opens = endpoint.streamOpens;
  endpoint.startOutage();
  await page.getByText("Browser connection interrupted").waitFor();
  endpoint.withholdState();
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  await page.keyboard.up("Shift");
  await page.getByRole("link", { name: "‹ Browsers" }).click();
  await until(() => endpoint.streams === 0);
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  assert.deepEqual(endpoint.commands, [{ t: "control", on: true }]);
});

test("a release still queued when the stream drops is sent once from the acknowledged press", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await screenClick(page);
  await page.keyboard.down("Shift");
  await until(() => endpoint.order.includes("key:rawKeyDown:Shift") && endpoint.activeInputs === 0);
  await nextFrames(page);
  endpoint.hold();
  await page.keyboard.press("a");
  await until(() => endpoint.activeInputs > 0);
  await page.keyboard.up("Shift");
  const opens = endpoint.streamOpens;
  endpoint.startOutage();
  await page.getByText("Browser connection interrupted").waitFor();
  endpoint.release();
  await until(() => endpoint.activeInputs === 0);
  endpoint.withholdState();
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  endpoint.hold();
  endpoint.releaseState();
  await until(() => endpoint.order.includes("key:keyUp:Shift"));
  assert.equal(await page.getByText("You’re in control").count(), 0);
  endpoint.release();
  await page.getByText("You’re in control").waitFor();
  assert.equal(endpoint.order.filter((entry) => entry === "key:keyUp:Shift").length, 1);
  await page.keyboard.up("Shift");
});

test("a key-down still in flight when the viewer leaves is not released after the stream drops", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.hold();
  await page.keyboard.down("Shift");
  await until(() => endpoint.order.includes("key:rawKeyDown:Shift"));
  await page.evaluate(() => {
    location.hash = "#/browser";
  });
  await page.getByRole("heading", { name: "Lane browsers" }).waitFor();
  assert.ok(endpoint.activeInputs > 0);
  assert.ok(endpoint.order.includes("key:rawKeyDown:Shift"));
  const opens = endpoint.streamOpens;
  endpoint.startOutage();
  await until(() => endpoint.rejected > 0);
  endpoint.withholdState();
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  endpoint.release();
  await until(() => endpoint.streams === 0);
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  assert.deepEqual(endpoint.commands, [{ t: "control", on: true }]);
  await page.keyboard.up("Shift");
});

test("a late acknowledgement from the old tab is not released onto the newly confirmed tab", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.hold();
  await page.keyboard.down("Shift");
  await until(() => endpoint.activeInputs > 0);
  const opens = endpoint.streamOpens;
  endpoint.startOutage();
  await page.getByText("Browser connection interrupted").waitFor();
  endpoint.withholdState();
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  endpoint.moveTab();
  endpoint.releaseState();
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Workshop" })
    .waitFor();
  endpoint.release();
  await until(() => endpoint.activeInputs === 0);
  await page.getByText("You’re in control").waitFor();
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  assert.deepEqual(endpoint.commands, [{ t: "control", on: true }]);
  await page.keyboard.up("Shift");
});

test("an input refusal during a pending tab change stops the change and the drain", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.order.length = 0;
  const opens = endpoint.streamOpens;
  endpoint.hold();
  endpoint.refuseNextInput();
  await page.keyboard.down("Shift");
  await until(() => endpoint.activeInputs > 0);
  await page.getByRole("button", { name: "Workshop" }).click();
  await page.locator('nav[aria-label="Remote tabs"] button:disabled').first().waitFor();
  endpoint.withholdState();
  endpoint.release();
  await page.getByText("Control ended. You’re watching again.").waitFor();
  await until(() => endpoint.streamOpens > opens);
  const sent = endpoint.events.length;
  await page.mouse.click(300, 250);
  await page.keyboard.press("x");
  await nextFrames(page);
  assert.equal(endpoint.events.length, sent);
  assert.equal(await page.locator(".browser-surface.driving").count(), 0);
  assert.equal(endpoint.order.includes("tab"), false);
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  assert.deepEqual(endpoint.commands, [{ t: "control", on: true }]);
  endpoint.releaseState();
  await page.locator(".browser-surface.driving").waitFor();
  await page.keyboard.up("Shift");
});

test("a command whose confirmed tab changed while its drain waited is not sent", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.hold();
  await page.keyboard.down("Shift");
  await until(() => endpoint.order.includes("key:rawKeyDown:Shift"));
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Returning control…" }).waitFor();
  endpoint.switchTab();
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Workshop" })
    .waitFor();
  endpoint.release();
  await page.getByText(/changed before your request went through/).waitFor();
  assert.deepEqual(endpoint.commands, [{ t: "control", on: true }]);
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  await page.keyboard.up("Shift");
});

test("a matching frame returning does not resume input until the held key is released", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.hold();
  await page.keyboard.down("Shift");
  await until(() => endpoint.order.includes("key:rawKeyDown:Shift"));
  await page.keyboard.press("b");
  endpoint.showFrame(1);
  await page.getByText("Control held · Input paused").waitFor();
  endpoint.showFrame(0);
  await page
    .locator(`.browser-surface img[src="data:image/jpeg;base64,${jpeg[0] ?? ""}"]`)
    .waitFor();
  assert.equal(await page.getByText("You’re in control").count(), 0);
  assert.equal(endpoint.order.includes("key:keyUp:Shift"), false);
  endpoint.releaseAndHold();
  await until(() => endpoint.order.includes("key:keyUp:Shift"));
  assert.equal(await page.getByText("You’re in control").count(), 0);
  endpoint.release();
  await page.getByText("You’re in control").waitFor();
  assert.equal(endpoint.order.filter((entry) => entry === "key:keyUp:Shift").length, 1);
  assert.equal(
    endpoint.order.some((entry) => /^key:(keyDown|keyUp):b$/i.test(entry)),
    false,
  );
  await screenClick(page);
  await until(() => endpoint.activeInputs === 0);
  await page.keyboard.up("Shift");
  await nextFrames(page);
  assert.equal(endpoint.order.filter((entry) => entry === "key:keyUp:Shift").length, 1);
});

test("a tab round trip does not reuse the cached frame for the returning tab", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.holdFrame();
  endpoint.switchTab();
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Workshop" })
    .waitFor();
  endpoint.switchTab(0);
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Garden" })
    .waitFor();
  assert.equal(await page.locator(".browser-surface").count(), 0);
  assert.equal(await page.getByText("You’re in control").count(), 0);
  endpoint.releaseFrame();
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[0] ?? ""}"]`)
    .waitFor();
});

test("a late frame for the old tab does not satisfy the tab confirmation that returns to it", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.holdFrame();
  endpoint.switchTab(1);
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Workshop" })
    .waitFor();
  endpoint.showFrame(0);
  endpoint.switchTab(0);
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Garden" })
    .waitFor();
  await nextFrames(page);
  assert.equal(await page.locator(".browser-surface.driving").count(), 0);
  assert.equal(await page.getByText("You’re in control").count(), 0);
  endpoint.releaseFrame();
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[0] ?? ""}"]`)
    .waitFor();
});

test("Done stays available when the stream confirms ownership with no open tab", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.closeAllTabs();
  await page.locator(".browser-surface").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Done", disabled: false }).waitFor();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("Control returned to the agent.").waitFor();
  assert.deepEqual(endpoint.commands, [{ t: "control", on: true }, { t: "done" }]);
  assert.equal(endpoint.controlled, false);
});

test("a static tab whose only frame preceded its state regains input through one fresh screencast", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.sendFrameBeforeState();
  const acked = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/command"),
  );
  await page.getByRole("button", { name: "Workshop" }).click();
  await acked;
  await page
    .locator(`.browser-surface:not(.driving) img[src="data:image/jpeg;base64,${jpeg[1] ?? ""}"]`)
    .waitFor();
  await nextFrames(page);
  assert.equal(await page.locator(".browser-surface.driving").count(), 0);
  assert.equal(endpoint.commands.length, 2);
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[1] ?? ""}"]`)
    .waitFor();
  assert.deepEqual(endpoint.commands.slice(1), [
    { t: "tab", action: "activate", id: "two" },
    { t: "tab", action: "activate", id: "two" },
  ]);
  endpoint.order.length = 0;
  await screenClick(page);
  await until(() => endpoint.order.includes("key:keyUp:x"));
  assert.equal(endpoint.commands.length, 3);
});

test("a frame sent before the first state of a reconnected stream is not trusted", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.sendFrameBeforeState();
  const opens = endpoint.streamOpens;
  const arrived = endpoint.arrivals;
  endpoint.hold();
  endpoint.startOutage();
  await page.getByText("Browser connection interrupted").waitFor();
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  await page
    .locator(`.browser-surface:not(.driving) img[src="data:image/jpeg;base64,${jpeg[0] ?? ""}"]`)
    .waitFor();
  await until(() => endpoint.arrivals === arrived + 1);
  assert.equal(await page.locator(".browser-surface.driving").count(), 0);
  assert.equal(endpoint.commands.length, 1);
  endpoint.release();
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[0] ?? ""}"]`)
    .waitFor();
  assert.deepEqual(endpoint.commands.slice(1), [{ t: "tab", action: "activate", id: "one" }]);
});

test("a queued tab request does not make an old frame for that tab trusted", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.holdFrame();
  endpoint.hold();
  await page.keyboard.down("Shift");
  await until(() => endpoint.order.includes("key:rawKeyDown:Shift"));
  await page.getByRole("button", { name: "Workshop" }).click();
  await page.locator('nav[aria-label="Remote tabs"] button:disabled').first().waitFor();
  endpoint.showFrame(1);
  endpoint.switchTab(1);
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Workshop" })
    .waitFor();
  assert.equal(await page.locator(".browser-surface.driving").count(), 0);
  endpoint.release();
  await nextFrames(page);
  assert.equal(await page.locator(".browser-surface.driving").count(), 0);
  assert.deepEqual(endpoint.commands, [{ t: "control", on: true }]);
  endpoint.releaseFrame();
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[1] ?? ""}"]`)
    .waitFor();
  await page.keyboard.up("Shift");
});

test("an acknowledged activation does not promote an earlier frame to input authority", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  endpoint.holdFrame();
  endpoint.hold();
  await page.getByRole("button", { name: "Workshop" }).click();
  await until(() => endpoint.arrivals === 2);
  endpoint.switchTab(0);
  endpoint.showFrame(1);
  endpoint.switchTab(1);
  await page
    .locator('nav[aria-label="Remote tabs"] button[aria-current="true"]', { hasText: "Workshop" })
    .waitFor();
  const acked = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/command"),
  );
  endpoint.release();
  await acked;
  await page
    .locator(`.browser-surface:not(.driving) img[src="data:image/jpeg;base64,${jpeg[1] ?? ""}"]`)
    .waitFor();
  await nextFrames(page);
  assert.equal(await page.locator(".browser-surface.driving").count(), 0);
  endpoint.releaseFrame();
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[1] ?? ""}"]`)
    .waitFor();
});
