/// <reference lib="dom" />
// The board in a real browser (spec section 21), served by a real cardd.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { CardSchema, check } from "@fleet/protocol";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));

let browser: Browser;
let cardd: Cardd;
let main: Session;
let page: Page;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});
beforeEach(async () => {
  cardd = await Cardd.start({}, ["--board", BOARD]);
  main = await cardd.connect(cardd.addLane("main"));
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
