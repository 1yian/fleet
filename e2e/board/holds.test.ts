import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CardSchema, check, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";

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
  await main.call("hold", { card: card.id, question: `${title}?`, options });
  return card;
}

test("a hold with several questions is one card with one set of answers, and one click settles it all", async () => {
  const card = await question("Pick the API version", ["Take all my recommendations", "Neither"]);
  await main.call("hold", {
    card: card.id,
    question: "1. Pick the API version?\n2. Ship on Friday?\n3. Use the new database?",
    options: ["Take all my recommendations", "Neither"],
  });
  await page.goto(http());
  const needs = page.getByRole("region", { name: "Needs you" });
  await needs.getByText("3. Use the new database?").waitFor();
  assert.equal(await needs.getByRole("article").count(), 1);
  assert.equal(await needs.getByRole("button", { name: "Take all my recommendations" }).count(), 1);

  await page.getByRole("button", { name: "Take all my recommendations" }).click();
  await page.getByText("Nothing for you").waitFor();
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "Take all my recommendations");
  assert.equal(main.entries.filter(({ entry }) => entry.kind === "answer").length, 1);
});
