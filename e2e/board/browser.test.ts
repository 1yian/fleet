import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { BrowserEndpoint, REASON } from "../support/browser-endpoint.ts";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import { tempDir } from "../support/run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
boundBoardFile();

async function renderedJpegs(page: Page): Promise<string[]> {
  const images: string[] = [];
  for (const color of ["forestgreen", "rebeccapurple"]) {
    await page.setContent(`<body style="background:${color}">`);
    images.push((await page.screenshot({ type: "jpeg" })).toString("base64"));
  }
  return images;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition());
}

function delivered(endpoint: BrowserEndpoint, match: Record<string, unknown>) {
  return endpoint.events.filter((item) =>
    Object.entries(match).every(([key, value]) => item[key] === value),
  );
}

function near(value: unknown, expected: number): void {
  assert.ok(typeof value === "number" && Math.abs(value - expected) <= 2, String(value));
}

async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

async function screenClick(page: Page): Promise<void> {
  const rect = await page.getByRole("img", { name: "Live browser screen" }).boundingBox();
  assert.ok(rect);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.press("x");
  await nextFrames(page);
}

async function exerciseInput(page: Page, endpoint: BrowserEndpoint): Promise<void> {
  await until(() => delivered(endpoint, { t: "key", type: "keyUp", key: "x" }).length === 1);
  const [pressed] = delivered(endpoint, { t: "mouse", type: "mousePressed" });
  assert.ok(pressed);
  assert.equal(pressed["button"], "left");
  assert.equal(pressed["clickCount"], 1);
  near(pressed["x"], 240);
  near(pressed["y"], 150);
  const [released] = delivered(endpoint, { t: "mouse", type: "mouseReleased" });
  assert.ok(released);
  near(released["x"], 240);
  near(released["y"], 150);
  assert.equal(delivered(endpoint, { t: "key", type: "keyDown", key: "x", text: "x" }).length, 1);

  endpoint.events.length = 0;
  const rect = await page.getByRole("img", { name: "Live browser screen" }).boundingBox();
  assert.ok(rect);
  await page.waitForTimeout(600);
  await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await until(() => delivered(endpoint, { t: "mouse", type: "mouseReleased" }).length === 2);
  assert.deepEqual(
    delivered(endpoint, { t: "mouse", type: "mousePressed" }).map((item) => item["clickCount"]),
    [1, 2],
  );
  assert.deepEqual(
    delivered(endpoint, { t: "mouse", type: "mouseReleased" }).map((item) => item["clickCount"]),
    [1, 2],
  );

  endpoint.events.length = 0;
  await page.keyboard.down("Shift");
  await page.keyboard.press("Escape");
  await page.keyboard.up("Shift");
  await until(() => delivered(endpoint, { t: "key", type: "keyUp", key: "Shift" }).length === 1);
  assert.equal(delivered(endpoint, { t: "key", type: "rawKeyDown", key: "Shift" }).length, 1);
  assert.equal(delivered(endpoint, { t: "key", key: "Escape" }).length, 0);

  endpoint.events.length = 0;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.locator(".browser-surface").dispatchEvent("pointercancel");
  await until(() => delivered(endpoint, { t: "mouse", type: "mouseReleased" }).length === 1);
  await page.mouse.up();
  await screenClick(page);
  await until(() => delivered(endpoint, { t: "key", type: "keyUp", key: "x" }).length === 1);
  const presses = delivered(endpoint, { t: "mouse", type: "mousePressed" });
  assert.equal(presses.length, 2);
  assert.equal(presses[1]?.["clickCount"], 1);
  assert.equal(delivered(endpoint, { t: "mouse", type: "mouseReleased" }).length, 2);

  endpoint.events.length = 0;
  const farX = rect.x + rect.width / 2 + 60;
  const midY = rect.y + rect.height / 2;
  await page.mouse.move(rect.x + rect.width / 2, midY);
  await page.mouse.down();
  await page.mouse.move(farX, midY, { steps: 4 });
  await page.mouse.up();
  await page.mouse.click(farX, midY);
  await until(() => delivered(endpoint, { t: "mouse", type: "mouseReleased" }).length === 2);
  const afterDrag = delivered(endpoint, { t: "mouse", type: "mousePressed" });
  assert.equal(afterDrag[1]?.["clickCount"], 1);
}

async function exerciseTabSwitch(page: Page, endpoint: BrowserEndpoint): Promise<void> {
  endpoint.order.length = 0;
  endpoint.hold();
  await screenClick(page);
  await until(() => endpoint.activeInputs > 0);
  await page.keyboard.down("Shift");
  await page.getByRole("button", { name: "Workshop" }).click();
  await page.keyboard.up("Shift");
  await page.locator('nav[aria-label="Remote tabs"] button:disabled').first().waitFor();
  assert.ok(endpoint.activeInputs > 0);
  assert.ok(!endpoint.order.includes("tab"));
  endpoint.release();
  await until(() => endpoint.order.includes("tab"));
  assert.equal(endpoint.activeInputsAtTab, 0);
  const tab = endpoint.order.indexOf("tab");
  assert.ok(endpoint.order.indexOf("key:rawKeyDown:Shift") < tab);
  assert.ok(
    endpoint.order.indexOf("key:keyUp:Shift") > endpoint.order.indexOf("key:rawKeyDown:Shift"),
  );
  assert.ok(endpoint.order.indexOf("key:keyUp:Shift") < tab);
}

async function exerciseAmbiguousTab(
  page: Page,
  endpoint: BrowserEndpoint,
  jpeg: readonly string[],
): Promise<void> {
  const batches = endpoint.events.length;
  const opens = endpoint.streamOpens;
  endpoint.withholdState();
  await page.getByRole("button", { name: "Garden" }).click();
  await page.getByText("Couldn’t switch tabs. Try again.").waitFor();
  await until(() => endpoint.streamOpens > opens);
  await page.getByText("Browser connection interrupted").waitFor();
  await page.mouse.click(300, 250);
  await page.keyboard.press("x");
  await nextFrames(page);
  assert.equal(endpoint.events.length, batches);
  endpoint.releaseState();
  await page.getByText("You’re in control").waitFor();
  await page.waitForFunction(
    (next) =>
      document.querySelector(".browser-surface img")?.getAttribute("src") ===
      `data:image/jpeg;base64,${next}`,
    jpeg[0],
  );
  await screenClick(page);
  await until(() => endpoint.events.length > batches);
}

async function exerciseOutage(page: Page, endpoint: BrowserEndpoint): Promise<void> {
  const commands = endpoint.commands.length;
  const batches = endpoint.events.length;
  endpoint.startOutage();
  await page.getByText("Browser connection interrupted").waitFor();
  await until(() => endpoint.rejected > 0);
  const opens = endpoint.streamOpens;
  endpoint.withholdState();
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  await page.mouse.click(300, 250);
  await page.keyboard.press("x");
  await nextFrames(page);
  assert.equal(endpoint.events.length, batches);
  await page.getByText("Browser connection interrupted").waitFor();
  endpoint.releaseState();
  await page.getByText("You’re in control").waitFor();
  assert.equal(endpoint.commands.length, commands);
  assert.equal(endpoint.events.length, batches);
  await screenClick(page);
  await until(() => endpoint.events.length > batches);
}

async function launch(t: TestContext) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const drawing = await openBoardPage(t, browser, { width: 480, height: 300 });
  const jpeg = await renderedJpegs(drawing);
  const endpoint = new BrowserEndpoint(jpeg);
  await new Promise<void>((resolve) => {
    endpoint.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    endpoint.server.closeAllConnections();
    endpoint.server.close();
  });
  const address = endpoint.server.address();
  assert.ok(address && typeof address !== "string");
  const token = join(tempDir("browser-token-"), "token");
  writeFileSync(token, endpoint.token, { mode: 0o600 });
  const cardd = await startBoardServer(t, BOARD, {
    CARDD_BROWSER_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
    CARDD_BROWSER_TOKEN_FILE: token,
  });
  const page = await openBoardPage(t, browser);
  const base = cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
  return { endpoint, jpeg, page, base };
}

test("the board watches lanes and only drives after stream confirmation, until control is returned or lost", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await page.goto(base);
  await page.getByRole("link", { name: "Browsers" }).click();
  await page.getByRole("link", { name: "garden Ready to watch" }).click();
  await page.getByText("Watching · Read only").waitFor();
  await page.getByRole("button", { name: "Workshop" }).click();
  await page.getByText("Take control to switch remote tabs.").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Garden" }).getAttribute("aria-current"),
    "true",
  );
  const sent: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/input")) sent.push(request.method());
  });
  await screenClick(page);
  assert.deepEqual(sent, []);
  await page.getByRole("link", { name: "‹ Browsers" }).click();
  await page.getByRole("link", { name: "‹ Board" }).click();
  endpoint.ask();
  await page.getByRole("link", { name: `garden needs you ${REASON}` }).click();
  await page.getByText(REASON).waitFor();

  const take = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/command"),
  );
  await page.getByRole("button", { name: "Take control" }).click();
  assert.equal((await take).status(), 204);
  await page.getByRole("button", { name: "Taking control…" }).waitFor();
  await screenClick(page);
  assert.deepEqual(sent, []);
  endpoint.confirm();
  await page.getByText("You’re in control").waitFor();
  const input = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/input"),
  );
  await screenClick(page);
  assert.equal((await input).status(), 204);
  await exerciseInput(page, endpoint);
  await exerciseTabSwitch(page, endpoint);
  await page.waitForFunction(
    (next) =>
      document.querySelector(".browser-surface img")?.getAttribute("src") ===
      `data:image/jpeg;base64,${next}`,
    jpeg[1],
  );
  assert.equal(
    await page.getByRole("button", { name: "Workshop" }).getAttribute("aria-current"),
    "true",
  );

  await exerciseOutage(page, endpoint);
  await exerciseAmbiguousTab(page, endpoint, jpeg);

  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("Control returned to the agent.").waitFor();
  await page.getByText(REASON).waitFor({ state: "hidden" });
  const retake = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/command"),
  );
  await page.getByRole("button", { name: "Take control" }).click();
  assert.equal((await retake).status(), 204);
  endpoint.confirm();
  await page.getByText("You’re in control").waitFor();
  endpoint.revoke();
  await page.getByText("Control ended. You’re watching again.").waitFor();
  const before = sent.length;
  await screenClick(page);
  assert.equal(sent.length, before);
  assert.equal(await page.getByText("viewer does not hold control").count(), 0);
});

test("leaving the board right after Take control does not leave the viewer holding control", async (t) => {
  const { endpoint, page, base } = await launch(t);
  await page.goto(`${base}#/browser/garden`);
  await page.getByText("Watching · Read only").waitFor();
  const issued = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/command"),
  );
  await page.getByRole("button", { name: "Take control" }).click();
  await issued;
  endpoint.hold();
  await page.getByRole("link", { name: "‹ Browsers" }).click();
  await nextFrames(page);
  assert.equal(endpoint.commands.length, 0);
  endpoint.release();
  await until(() => endpoint.commands.length === 2);
  assert.deepEqual(endpoint.commands, [
    { t: "control", on: true },
    { t: "control", on: false },
  ]);
});
