import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CardSchema, check, OPS } from "@fleet/protocol";
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

test("the Mates section shows each second mate's lane card, and its detail is the talk with main", async () => {
  await page.goto(http());
  await page.getByText("Nothing for you").waitFor();
  assert.equal(await page.getByRole("region", { name: "Mates" }).count(), 0);

  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  await main.call("card.new", { title: "Users see one scrollbar", kind: "scout" });
  await main.call("comment", { lane: "cleo", text: "The captain asks: how are ads doing?" });
  await cleo.call("comment", { lane: "cleo", text: "Ads are under budget, 3 of 5 convert." });

  const mates = page.getByRole("region", { name: "Mates" });
  await mates.getByText("Ads are under budget, 3 of 5 convert.").waitFor();
  assert.deepEqual(await mates.locator(".title").allTextContents(), ["cleo"]);
  const queued = page.getByRole("region", { name: "Up next" });
  assert.deepEqual(await queued.locator(".title").allTextContents(), ["Users see one scrollbar"]);

  await mates.getByRole("link", { name: /cleo/ }).click();
  const thread = page.getByRole("list", { name: "Thread" });
  await thread.getByText("The captain asks: how are ads doing?").waitFor();
  await thread.getByText("Ads are under budget, 3 of 5 convert.").waitFor();
  assert.deepEqual(await thread.locator(".flow").allInnerTexts(), ["main → cleo", "cleo → main"]);
  await page.getByRole("textbox", { name: "Comment" }).fill("Thanks, cleo");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const heard = await main.waitForEntry((entry) => entry.author === "captain", "the captain");
  assert.equal(heard.body, "Thanks, cleo");
  await main.call("comment", { lane: "cleo", text: "Nothing more from the captain" });
  await cleo.waitForEntry((entry) => entry.body === "Nothing more from the captain", "main");
  assert.equal(cleo.entries.filter(({ entry }) => entry.author === "captain").length, 0);
});

test("a second mate's hold is not in Needs you until main escalates it", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const card = check(CardSchema, await cleo.call("card.new", { title: "Ads", kind: "scout" }));
  await cleo.call("hold", {
    card: card.id,
    question: "Which channel?",
    options: ["search", "social"],
  });
  const cards = check(OPS.board.result, await cleo.call("board", {}));
  assert.equal(cards.find((each) => each.id === card.id)?.status, "with-mate");

  await page.goto(http());
  const running = page.getByRole("region", { name: "In progress" });
  await running.getByText("Asks main: Which channel?").waitFor();
  await running.locator(".chip", { hasText: "with main" }).waitFor();
  await page.getByText("Nothing for you").waitFor();
  assert.equal(await page.getByRole("button", { name: "search" }).count(), 0);

  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "Cleo asks which channel. I recommend search.",
    options: ["search", "social"],
  });
  const needs = page.getByRole("region", { name: "Needs you" });
  await needs.getByText("Cleo asks which channel. I recommend search.").waitFor();
  await needs.getByRole("button", { name: "search" }).click();
  const answer = await cleo.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "search");
});

test("the board refuses an answer to a hold that is still with main", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const card = check(CardSchema, await cleo.call("card.new", { title: "Ads", kind: "scout" }));
  await cleo.call("hold", { card: card.id, question: "Which channel?", options: ["search"] });
  const ask = await main.waitForEntry((entry) => entry.kind === "hold", "the hold");
  const current = check(OPS.board.result, await cleo.call("board", {})).find(
    (each) => each.id === card.id,
  );
  const response = await fetch(`${http()}api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      card: card.id,
      revision: current?.revision,
      action: { kind: "answer", hold: ask.id, choice: "search" },
    }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /with main/);
});

test("a reply that a second mate owes main shows on its lane card and in its detail, until it answers", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  await main.call("comment", { lane: "cleo", text: "Is the ads report ready?", reply: true });
  await page.goto(http());
  const mates = page.getByRole("region", { name: "Mates" });
  await mates.getByText("Reply owed").waitFor();
  assert.equal(await mates.locator(".chip.owed").getAttribute("title"), "cleo owes main a reply");

  await mates.getByRole("link", { name: /cleo/ }).click();
  const replies = page.getByRole("list").filter({ hasText: "cleo owes main" });
  assert.match((await replies.textContent()) ?? "", /^cleo owes mainr-\d+ · asked just now$/);

  const asked = await cleo.waitForEntry((entry) => entry.fields["owes"] === "cleo", "the ask");
  await cleo.call("comment", {
    lane: "cleo",
    text: "Yes: /tmp/ads.md",
    replyTo: `r-${String(asked.id)}`,
  });
  await page.getByRole("list", { name: "Thread" }).getByText("Yes: /tmp/ads.md").waitFor();
  await replies.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Fleet" }).click();
  await mates.getByText("Yes: /tmp/ads.md").waitFor();
  assert.equal(await mates.getByText("Reply owed").count(), 0);
});
