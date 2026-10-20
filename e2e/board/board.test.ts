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

test("Kanban shows each card in its lane and status, and the drawer shows its thread", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await main.call("comment", { card: card.id, text: "the captain prefers v2" });
  await page.goto(http());
  await page.getByRole("radio", { name: /Kanban/ }).click();
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "main" }) });
  await row.getByRole("button", { name: /Pick the API version/ }).click();

  const message = page.getByRole("complementary").getByText("the captain prefers v2");
  await message.waitFor();
  // Visible to the eye, not only to the DOM: the thread's fade-in must finish at full opacity.
  const handle = await message.elementHandle();
  await page.waitForFunction((element) => getComputedStyle(element).opacity === "1", handle, {
    timeout: 5_000,
  });
});

test("a reply draft survives a new entry on the open card", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await page.goto(http());
  await page.getByRole("radio", { name: /Kanban/ }).click();
  await page.getByRole("button", { name: /Pick the API version/ }).click();
  const reply = page.getByRole("textbox", { name: "Reply" });
  await reply.fill("I prefer v2 because");

  await main.call("comment", { card: card.id, text: "the mate adds a note" });
  await page.getByRole("complementary").getByText("the mate adds a note").waitFor();
  assert.equal(await reply.inputValue(), "I prefer v2 because");
});

test("a reply draft does not follow the captain to another card", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  const other = await question("Renew the certificate", ["now", "later"]);
  await page.goto(http());
  await page.getByRole("radio", { name: /Kanban/ }).click();
  await page.getByRole("button", { name: /Pick the API version/ }).click();
  await page.getByRole("textbox", { name: "Reply" }).fill("I prefer v2 because");

  await page.getByRole("button", { name: /Renew the certificate/ }).click();
  await page.getByRole("heading", { name: new RegExp(`^c-${String(other.id)} `) }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Reply" }).inputValue(), "");
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
  await page.getByRole("radio", { name: /Kanban/ }).click();
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

  await page.getByRole("radio", { name: /Kanban/ }).click();
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

test("the drawer fits a phone viewport", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(http());
  await page.getByRole("button", { name: /Pick the API version/ }).click();
  const drawer = page.getByRole("complementary");
  await drawer.getByRole("heading", { name: "Thread" }).waitFor();

  const box = await drawer.boundingBox();
  assert.ok(box !== null && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
});
