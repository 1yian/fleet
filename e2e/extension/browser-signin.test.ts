import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  chromium,
  devices,
  type Browser as Client,
  type BrowserContext,
  type Page,
} from "playwright";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { startViewer, type CaptainViewer } from "../support/captain-viewer.ts";
import { ACCOUNT, SignInSite } from "../support/signin-site.ts";

const WAIT_MS = 20_000;
const ACCOUNTS = "accounts.example.test";
const MY_ACCOUNT = "myaccount.nothing.test";

let lab: BrowserLab;
let site: SignInSite;
let worker: RawWorker;
let viewer: CaptainViewer;
let client: Client;
let context: BrowserContext | undefined;

beforeEach(async () => {
  lab = await BrowserLab.start({ proxied: true, isolated: true });
  site = await SignInSite.start(MY_ACCOUNT);
  worker = await lab.worker("Sign in to My Account");
  viewer = await startViewer(lab, ["--captain"]);
  client = await chromium.launch();
});

afterEach(async () => {
  await context?.close();
  context = undefined;
  const stopped = await Promise.allSettled([
    client.close(),
    viewer.stop(),
    site.stop(),
    lab.stop(),
  ]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const IPHONE = devices["iPhone 13"];

async function viewerPage(kind: "mac" | "phone"): Promise<Page> {
  context = await client.newContext(
    kind === "mac" ? { viewport: { width: 1440, height: 900 } } : { ...IPHONE },
  );
  const page = await context.newPage();
  await page.goto(viewer.url);
  await page.locator("#tabs li").first().waitFor();
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["FLEET_EVIDENCE_DIR"];
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

const onRemote = async (expression: string): Promise<unknown> =>
  JSON.parse(await worker.act({ action: "eval", expression }));

const remoteHas = async (selector: string): Promise<boolean> =>
  (await onRemote(`document.querySelector(${JSON.stringify(selector)}) !== null`)) === true;

const remoteText = async (selector: string): Promise<string> =>
  String(await onRemote(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`));

const remoteValue = async (selector: string): Promise<string> =>
  String(await onRemote(`document.querySelector(${JSON.stringify(selector)})?.value ?? ""`));

async function atRemote(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const measured = await onRemote(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, innerWidth, innerHeight]; })()`,
  );
  assert.ok(Array.isArray(measured) && measured.every((each) => typeof each === "number"));
  const [x = 0, y = 0, width = 1, height = 1] = measured;
  const box = await page.locator("#screen").boundingBox();
  assert.ok(box !== null, "the picture is on screen");
  return { x: box.x + (x / width) * box.width, y: box.y + (y / height) * box.height };
}

async function live(page: Page): Promise<void> {
  await until(async () => (await page.locator("#live").textContent()) === "live", "a live picture");
}

async function pick(page: Page, touch: boolean): Promise<void> {
  const tab = page.locator("#tabs li").first();
  if ((await page.locator("#live").textContent()) !== "live")
    await (touch ? tab.tap() : tab.click());
  await live(page);
  const phone = page.viewportSize();
  if (touch && phone !== null)
    await until(
      async () => Number((await onRemote("innerWidth")) ?? 0) === phone.width,
      "the tab to take the phone's width",
    );
}

async function waitForRemote(selector: string): Promise<void> {
  await until(() => remoteHas(selector), `${selector} on the sign-in page`);
}

test("Mac: the captain signs in through the viewer with a mouse and keys, across the second factor and a change of site", async () => {
  await worker.act({ action: "open", url: site.url("/signin", ACCOUNTS) });
  const page = await viewerPage("mac");
  await pick(page, false);
  await shot(page, "mac-1-identifier");

  const field = await atRemote(page, "#identifier");
  await page.mouse.click(field.x, field.y);
  await page.keyboard.type(ACCOUNT.identifier);
  await until(async () => (await remoteValue("#identifier")) === ACCOUNT.identifier, "the email");
  await page.keyboard.press("Enter");

  await waitForRemote("#password");
  await live(page);
  await page.keyboard.type(ACCOUNT.password);
  await shot(page, "mac-2-password");
  await page.keyboard.press("Enter");

  await waitForRemote("#code");
  await shot(page, "mac-3-code");
  await page.keyboard.type(ACCOUNT.code);
  await page.keyboard.press("Enter");

  await waitForRemote("#welcome");
  assert.equal(await remoteText("#welcome"), `Signed in as ${ACCOUNT.identifier}`);
  assert.ok(site.signedIn);
  const before = await page.locator("#screen").evaluate((img: HTMLImageElement) => img.src);
  await until(async () => (await page.locator("#live").textContent()) === "live", "live");
  assert.ok(before.length > 0);
  await shot(page, "mac-4-signed-in");
});

test("phone: the captain signs in by touch, with the keyboard button and the key bar", async () => {
  await worker.act({ action: "open", url: site.url("/signin", ACCOUNTS) });
  const page = await viewerPage("phone");
  await pick(page, true);
  await shot(page, "phone-1-identifier");

  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    picture: document.getElementById("screen")?.getBoundingClientRect().width ?? 0,
    viewport: innerWidth,
  }));
  assert.ok(layout.overflow <= 0, "the page does not scroll sideways");
  assert.ok(layout.picture >= layout.viewport * 0.9, "the picture fills the phone's width");

  const field = await atRemote(page, "#identifier");
  await page.touchscreen.tap(field.x, field.y);
  await page.locator("#keyboard").tap();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "typer");
  await page.keyboard.insertText(ACCOUNT.identifier);
  await until(async () => (await remoteValue("#identifier")) === ACCOUNT.identifier, "the email");
  await page.locator("#keys [data-key='Enter']").tap();

  await waitForRemote("#password");
  await live(page);
  await page.keyboard.insertText(ACCOUNT.password);
  await shot(page, "phone-2-password");
  const next = await atRemote(page, "#next");
  await page.touchscreen.tap(next.x, next.y);

  await waitForRemote("#code");
  await shot(page, "phone-3-code");
  await page.keyboard.insertText(ACCOUNT.code);
  await page.locator("#keys [data-key='Enter']").tap();

  await waitForRemote("#welcome");
  assert.equal(await remoteText("#welcome"), `Signed in as ${ACCOUNT.identifier}`);
  assert.ok(site.signedIn);
  await shot(page, "phone-4-signed-in");
});

test("phone: a swipe scrolls the page in the tab, and a tap then accepts the terms", async () => {
  await worker.act({ action: "open", url: site.url("/terms", ACCOUNTS) });
  const page = await viewerPage("phone");
  await pick(page, true);
  const scrolled = async (): Promise<number> => Number(await onRemote("Math.round(scrollY)"));
  assert.equal(await scrolled(), 0);

  const box = await page.locator("#screen").boundingBox();
  assert.ok(box !== null);
  const cdp = await context?.newCDPSession(page);
  assert.ok(cdp !== undefined);
  const x = box.x + box.width / 2;
  const swipeUp = async (): Promise<void> => {
    const from = box.y + box.height * 0.85;
    const to = box.y + box.height * 0.15;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: from }],
    });
    for (let step = 1; step <= 10; step += 1)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: from + ((to - from) * step) / 10 }],
      });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const atEnd = async (): Promise<boolean> =>
    (await onRemote("innerHeight + scrollY >= document.body.scrollHeight - 2")) === true;
  await swipeUp();
  await until(async () => (await scrolled()) > 0, "the swipe to scroll the page");
  await shot(page, "phone-5-terms-scrolled");
  for (let swipes = 0; swipes < 30 && !(await atEnd()); swipes += 1) {
    const before = await scrolled();
    await swipeUp();
    await until(async () => (await scrolled()) > before || (await atEnd()), "the next swipe");
  }
  assert.ok(await atEnd(), "swiping reaches the end of the terms");
  await shot(page, "phone-5-terms-end");

  const agree = await atRemote(page, "#agree");
  await page.touchscreen.tap(agree.x, agree.y);
  await waitForRemote("#welcome");
  assert.ok(site.signedIn);
});

test("phone: the page in the tab is laid out for the phone's width while the captain watches", async () => {
  await worker.act({ action: "open", url: site.url("/signin", ACCOUNTS) });
  const desktop = await onRemote("[innerWidth, innerHeight]");
  assert.ok(
    Array.isArray(desktop) && Number(desktop[0]) > 700,
    "the tab starts at the window size",
  );
  const page = await viewerPage("phone");
  await pick(page, true);

  const phone = page.viewportSize();
  assert.ok(phone !== null);
  await shot(page, "phone-6-fitted");
  await page.locator("#keyboard").tap();
  await until(
    async () => Number(await onRemote("innerHeight")) < phone.height - 150,
    "the tab to give room to the key bar",
  );
});

test("phone: the keyboard's Backspace deletes what was typed, and the key bar reaches the page", async () => {
  await worker.act({ action: "open", url: site.url("/signin", ACCOUNTS) });
  const page = await viewerPage("phone");
  await pick(page, true);
  const field = await atRemote(page, "#identifier");
  await page.touchscreen.tap(field.x, field.y);
  await page.locator("#keyboard").tap();

  await page.keyboard.insertText("captainx");
  await until(async () => (await remoteValue("#identifier")) === "captainx", "the typed text");
  await page.keyboard.press("Backspace");
  await until(async () => (await remoteValue("#identifier")) === "captain", "the Backspace");

  await page.locator("#keys [data-key='Backspace']").tap();
  await until(async () => (await remoteValue("#identifier")) === "captai", "the Backspace button");
  await page.locator("#keys [data-key='Tab']").tap();
  await until(
    async () => (await onRemote("document.activeElement?.id")) === "next",
    "Tab to move on to the button",
  );
});

test("the captain's link opens when it is tapped on another site's page, as in a chat app", async () => {
  await worker.act({ action: "open", url: site.url("/signin", ACCOUNTS) });
  context = await client.newContext({ ...IPHONE });
  const page = await context.newPage();
  await page.route("http://chat.example.org/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<a id="link" href="${viewer.url}">Open the browser</a>`,
    }),
  );
  await page.goto("http://chat.example.org/");

  await page.locator("#link").tap();

  await page.locator("#tabs li").first().waitFor();
  assert.equal(await page.locator("#tabs li .card").count(), 1);
});
