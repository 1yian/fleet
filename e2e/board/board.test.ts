/// <reference lib="dom" />
// The board in a real browser (spec section 21), served by a real cardd.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { CardSchema, check, OPS } from "@fleet/protocol";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));

let browser: Browser;
let cardd: Cardd;
let main: Session;
let mainToken: string;
let page: Page;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});
beforeEach(async () => {
  cardd = await Cardd.start({}, ["--board", BOARD]);
  mainToken = cardd.addLane("main");
  main = await cardd.connect(mainToken);
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
  await cardd.stop();
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

async function question(title: string, options: string[]): Promise<Card> {
  const card = check(CardSchema, await main.call("card.new", { title, kind: "captain" }));
  await main.call("ask", { card: card.id, question: `${title}?`, options });
  return card;
}

test("Needs you shows each question, and one click answers it", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await page.goto(http());
  await page.getByText("Pick the API version?").waitFor();

  await page.getByRole("button", { name: "v2" }).click();
  await page.getByText("Nothing waits on you.").waitFor();
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.deepEqual([answer.author, answer.body], ["captain", "v2"]);
});

test("each open question of one card is shown, and a click answers that question", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await main.call("ask", { card: card.id, question: "Ship on Friday?", options: ["yes", "no"] });
  await page.goto(http());
  await page.getByText("Ship on Friday?").waitFor();
  await page.getByText("Pick the API version?").waitFor();

  await page.getByRole("button", { name: "yes" }).click();
  await page.getByText("Ship on Friday?").waitFor({ state: "detached" });
  await page.getByText("Pick the API version?").waitFor();
  await page.getByRole("button", { name: "v1" }).click();
  await page.getByText("Nothing waits on you.").waitFor();
  const answers = await main.waitForEntries(2);
  assert.deepEqual(
    answers.map((entry) => entry.body),
    ["yes", "v1"],
  );
});

test("number keys with a modifier do not answer", async () => {
  await question("Ship on Friday", ["yes", "no"]);
  await page.goto(http());
  await page.getByText("Ship on Friday?").waitFor();
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Alt+1");
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("2");
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "no");
  assert.equal(main.entries.filter(({ entry }) => entry.kind === "answer").length, 1);
});

test("a number key answers the first question", async () => {
  await question("Ship on Friday", ["yes", "no"]);
  await page.goto(http());
  await page.getByText("Ship on Friday?").waitFor();
  await page.keyboard.press("2");

  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "no");
});

test("a click on a card that changed since the captain looked is refused", async () => {
  await page.routeWebSocket(/\/live$/, () => undefined);
  const card = await question("Renew the certificate", ["now", "later"]);
  await page.goto(http());
  await page.getByText("Renew the certificate?").waitFor();
  await main.call("hold", {
    card: card.id,
    until: Date.now() + 3_600_000,
    reason: "after the freeze",
  });

  await page.getByRole("button", { name: "now" }).click();
  await page
    .getByRole("alert")
    .getByText(`c-${String(card.id)} changed since you looked`)
    .waitFor();
  assert.equal(main.entries.filter(({ entry }) => entry.kind === "answer").length, 0);
});

test("the inbox groups the cards: Needs you, Running, and Done", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await main.call("card.new", { title: "Users see one scrollbar", kind: "scout" });
  const done = check(CardSchema, await main.call("card.new", { title: "Ads", kind: "scout" }));
  const text = "Search ads convert best.";
  await main.call("close.finish", { card: done.id, mode: "done", text, archives: [], left: [] });
  await page.goto(http());

  const titles = (group: string) =>
    page.getByRole("region", { name: group }).locator(".task-title").allTextContents();
  await page.getByRole("region", { name: "Done" }).getByText(text).waitFor();
  assert.deepEqual(await titles("Needs you"), ["Pick the API version"]);
  assert.deepEqual(await titles("Running"), ["Users see one scrollbar"]);
  assert.deepEqual(await titles("Done"), ["Ads"]);
});

test("a card opens in place to one line per update, without the mate's instructions to the worker", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await main.call("comment", { card: card.id, text: "Spec: build the v2 endpoint" });
  const detail = "v2 drops the legacy fields.";
  await main.call("ask", { card: card.id, question: `Ship v2 now?\n${detail}`, options: ["yes"] });
  await page.goto(http());
  const opened = page.getByRole("article", { name: "Pick the API version" });
  await opened.getByRole("button", { name: /Pick the API version/ }).click();

  const updates = opened.getByRole("list", { name: "Updates" });
  await updates.getByText("Ship v2 now?").waitFor();
  assert.equal(await updates.getByText("Spec: build the v2 endpoint").count(), 0);
  assert.equal(await updates.getByText(detail).count(), 0);
  await updates.getByRole("button", { name: /Ship v2 now\?/ }).click();
  await updates.getByText(detail).waitFor();
});
test("a reply draft survives a new entry on the open card", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await page.goto(http());
  const opened = page.getByRole("article", { name: "Pick the API version" });
  await opened.getByRole("button", { name: /Pick the API version/ }).click();
  const reply = opened.getByRole("textbox", { name: "Reply" });
  await reply.fill("I prefer v2 because");

  await main.call("ask", { card: card.id, question: "Ship on Friday?", options: ["yes", "no"] });
  await opened.getByRole("list", { name: "Updates" }).getByText("Ship on Friday?").waitFor();
  assert.equal(await reply.inputValue(), "I prefer v2 because");
});
test("a reply draft does not follow the captain to another card", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await question("Renew the certificate", ["now", "later"]);
  await page.goto(http());
  const first = page.getByRole("article", { name: "Pick the API version" });
  await first.getByRole("button", { name: /Pick the API version/ }).click();
  await first.getByRole("textbox", { name: "Reply" }).fill("I prefer v2 because");

  const other = page.getByRole("article", { name: "Renew the certificate" });
  await other.getByRole("button", { name: /Renew the certificate/ }).click();
  assert.equal(await other.getByRole("textbox", { name: "Reply" }).inputValue(), "");
  assert.equal(await first.getByRole("textbox", { name: "Reply" }).count(), 0);
});
test("a refused reply comes back into the reply box", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await page.route("**/api/action", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "the card changed since you looked" }),
    }),
  );
  await page.goto(http());
  await page.getByRole("button", { name: /Pick the API version/ }).click();
  const reply = page.getByRole("textbox", { name: "Reply" });
  await reply.fill("I prefer v2 because");
  await page.getByRole("button", { name: "Send reply" }).click();

  await page.getByRole("alert").getByText("the card changed since you looked").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>("input[aria-label=Reply]")?.value ===
      "I prefer v2 because",
    undefined,
    { timeout: 5_000 },
  );
});

test("the board reloads after its live socket reconnects", async () => {
  await page.goto(http());
  await page.getByText("Nothing waits on you.").waitFor();

  await cardd.restart();
  main = await cardd.connect(mainToken);
  await question("Renew the certificate", ["now", "later"]);
  await page.getByText("Renew the certificate?").waitFor();
});

test("a board load that finishes late does not replace a newer one", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  let calls = 0;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/board", async (route) => {
    calls += 1;
    if (calls > 1) {
      await route.continue();
      return;
    }
    const stale = await route.fetch();
    await held;
    await route.fulfill({ response: stale });
  });
  await page.goto(http());
  await page.getByText("Pick the API version?").waitFor();

  await question("Renew the certificate", ["now", "later"]);
  await page.getByText("Renew the certificate?").waitFor();
  release();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.getByText("Renew the certificate?").isVisible(), true);
});

test("a question shows on its card whatever the card's status", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const card = check(CardSchema, await cleo.call("card.new", { title: "Ads", kind: "scout" }));
  await cleo.call("ask", {
    card: card.id,
    question: "Which channel?",
    options: ["search", "social"],
  });
  const cards = check(OPS.board.result, await cleo.call("board", {}));
  assert.equal(cards.find((each) => each.id === card.id)?.status, "with-first-mate");

  await page.goto(http());
  await page.getByText("Which channel?").waitFor();
});

test("a request that cannot reach cardd shows a notice, and a refused reply stays in the box", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await page.route("**/api/action", (route) => route.abort());
  await page.goto(http());
  await page.getByText("Pick the API version?").waitFor();
  await page.getByRole("button", { name: "v1" }).click();
  await page
    .getByRole("alert")
    .getByText(/The board could not reach cardd/)
    .waitFor();

  await page.getByRole("button", { name: /Pick the API version/ }).click();
  const reply = page.getByRole("textbox", { name: "Reply" });
  await reply.fill("I prefer v2 because");
  await page.getByRole("button", { name: "Send reply" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>("input[aria-label=Reply]")?.value ===
      "I prefer v2 because",
    undefined,
    { timeout: 5_000 },
  );
});

test("a board load that cannot reach cardd shows a notice that goes away when loading works", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  let blocked = true;
  await page.route("**/api/board", (route) => (blocked ? route.abort() : route.continue()));
  await page.goto(http());
  await page
    .getByRole("alert")
    .getByText(/The board could not reach cardd/)
    .waitFor();

  blocked = false;
  await main.call("comment", { card: 1, text: "wake the board" });
  await page.getByText("Pick the API version?").waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
});

/** Elements wider than their box that the captain could scroll sideways. */
const sideways = (target: Page): Promise<string[]> =>
  target.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll("body *")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .filter((element) => !["hidden", "clip"].includes(getComputedStyle(element).overflowX))
      .map((element) => element.className || element.tagName),
  );

test("nothing scrolls sideways, on a desktop or a phone, even with long unbroken text", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  const url = `https://example.com/${"a".repeat(240)}`;
  await main.call("ask", { card: card.id, question: `Evidence:\n${url}`, options: ["ok"] });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(http());
    await page.getByRole("button", { name: /Pick the API version/ }).click();
    await page.getByRole("button", { name: /Evidence:/ }).click();
    await page.getByRole("list", { name: "Updates" }).getByText(url).waitFor();
    assert.deepEqual(await sideways(page), [], `at ${String(viewport.width)} px`);
  }
});
