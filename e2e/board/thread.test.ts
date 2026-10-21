/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];

let browser: Browser;
let cardd: Cardd;
let main: Session;
let cleo: Session;
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
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  page = await browser.newPage({ viewport: { width: 900, height: 900 } });
});
afterEach(async () => {
  await page.close();
  await cardd.stop();
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
const thread = (): Locator => page.getByRole("list", { name: "Thread" });
const flows = (): Promise<string[]> => thread().locator(".flow").allInnerTexts();

async function shoot(name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await thread().screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function scout(mate: Session, title: string): Promise<Card> {
  return check(CardSchema, await mate.call("card.new", { title, kind: "scout" }));
}

async function open(card: Card): Promise<void> {
  await page.goto(`${http()}#/c-${String(card.id)}`);
  await thread().waitFor();
}

async function shipped(title: string): Promise<{ card: Card; worker: Session }> {
  cardd.addProject("web", { local: "/clones/web" }, "acme/web");
  const card = check(
    CardSchema,
    await cleo.call("card.new", { title, kind: "ship", project: "web" }),
  );
  const begun = await cleo.call("attempt.begin", { card: card.id, host: "local", task: "fix it" });
  return { card, worker: await cardd.connect(check(OPS["attempt.begin"].result, begun).token) };
}

const WORDS = "Neither of those: try podcasts and newsletters, then report the cost of each.";

async function escalated(card: Card): Promise<void> {
  await cleo.call("hold", { card: card.id, question: "Which channel?", options: ["search"] });
  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "Cleo asks which channel. I recommend search.",
    options: ["search", "social"],
  });
}

test("the captain's answer shows once, quotes of it fold away, and every entry says who it is for", async () => {
  const card = await scout(cleo, "Ads stay under budget");
  await escalated(card);
  assert.equal(await cardd.act(card.id, { kind: "comment", text: WORDS }), 200);
  await main.call("release", { card: card.id, words: WORDS, source: "board" });
  await main.call("comment", {
    card: card.id,
    text: `The captain said: "${WORDS}" Run both and send me the numbers.`,
  });
  await open(card);
  await thread().getByText("Run both and send me the numbers.").waitFor();
  await shoot("thread-duplication");

  assert.deepEqual(await flows(), ["cleo → main", "main → You", "You → main", "main → cleo"]);
  assert.equal((await thread().innerText()).split(WORDS).length - 1, 1);
  assert.equal(await thread().getByText("answered", { exact: true }).count(), 0);
  await thread()
    .getByText("The captain said: (your words above) Run both and send me the numbers.")
    .waitFor();
});

test("mate-to-mate steps are quiet log rows, and the captain's own words are the messages", async () => {
  const card = await scout(cleo, "Ads stay under budget");
  await escalated(card);
  assert.equal(await cardd.act(card.id, { kind: "comment", text: WORDS }), 200);
  await main.call("comment", { card: card.id, text: "Run both and send me the numbers." });
  await open(card);
  await thread().getByText("Run both and send me the numbers.").waitFor();
  await shoot("thread-quiet-rows");

  const quiet = await thread().locator("li.event.quiet .flow").allInnerTexts();
  assert.deepEqual(quiet, ["cleo → main", "main → cleo"]);
  const messages = await thread().locator("li.message .flow").allInnerTexts();
  assert.deepEqual(messages, ["main → You", "You → main"]);
  assert.equal(await thread().locator("li.message", { hasText: WORDS }).count(), 1);
});

test("the open question names the mate who wrote it and the one who escalated it", async () => {
  const card = await scout(cleo, "Ads stay under budget");
  await escalated(card);
  await open(card);
  const footer = thread().locator("li.event", { hasText: "waiting for your answer" });
  await footer.waitFor();
  await shoot("thread-escalated-footer");
  assert.equal(await footer.locator(".flow").innerText(), "cleo → You");
  await footer.getByText("escalated by main").waitFor();
  assert.equal(await footer.getByText("main asked a question").count(), 0);
});

test("one mate's order to its worker and its answer to main read differently, with the captain's words once", async () => {
  const { card, worker } = await shipped("Plan the handoff");
  await worker.waitForEntries(1);
  assert.equal(await cardd.act(card.id, { kind: "comment", text: WORDS }), 200);
  await main.waitForEntry((entry) => entry.author === "captain", "the captain's comment");
  await cleo.call("comment", {
    card: card.id,
    text: `The captain asked: "${WORDS}" Build the prototype and measure.`,
  });
  await cleo.call("hold", { card: card.id, question: "Is a local prototype enough?" });
  await open(card);
  await thread().getByText("Is a local prototype enough?").waitFor();
  await shoot("thread-same-sender");

  assert.deepEqual(await flows(), ["cleo → worker", "You → main", "cleo → worker", "cleo → main"]);
  assert.equal((await thread().innerText()).split(WORDS).length - 1, 1);
  await thread().getByText("(your words above) Build the prototype and measure.").waitFor();
});

test("a worker's report reads worker to its mate, and the task reads mate to worker", async () => {
  const { card, worker } = await shipped("Fix the footer");
  await worker.call("report", { status: "working", text: "reading the footer code" });
  await cleo.waitForEntry((entry) => entry.kind === "report", "the report");
  await open(card);
  await thread().getByText("reading the footer code").waitFor();
  assert.deepEqual(await flows(), ["cleo → worker", "worker → cleo"]);
});

test("an entry that carries a reply-to shows a link to the message it answers", async () => {
  const card = await scout(main, "Why Myrtle only");
  assert.equal(
    await cardd.act(card.id, { kind: "comment", text: "Why does only Myrtle break?" }),
    200,
  );
  const asked = await main.waitForEntry((entry) => entry.author === "captain", "the question");
  await main.call("comment", {
    card: card.id,
    text: "Only Myrtle has an allowlist.",
    replyTo: `r-${String(asked.id)}`,
  });
  await open(card);
  const reply = thread().getByRole("button", {
    name: /In reply to your message.*Why does only Myrtle break\?/,
  });
  await reply.waitFor();
  assert.equal(
    await thread().locator(".message.captain > .replies > .message .flow").innerText(),
    "main → You",
  );
  assert.equal(
    await thread()
      .getByRole("button", { name: /In reply to/ })
      .count(),
    1,
  );
  await reply.click();
  await page.locator(`#entry-${String(asked.id)}`).waitFor();
});

test("the same short answer to a later question is not mistaken for a duplicated hold clear", async () => {
  const card = await scout(main, "Two separate approvals");
  await main.call("hold", {
    card: card.id,
    question: "Start the first experiment?",
    options: ["Yes"],
  });
  assert.equal(await cardd.act(card.id, { kind: "comment", text: "Yes" }), 200);
  await main.call("release", { card: card.id, words: "Yes", source: "board" });
  await main.call("hold", {
    card: card.id,
    question: "Start the second experiment?",
    options: ["Yes"],
  });
  await main.call("release", { card: card.id, words: "Yes", source: "chat" });
  await open(card);
  const answers = thread().locator('li[data-kind="answer"]');
  await answers.getByText("Yes", { exact: true }).waitFor();
  assert.equal(await answers.count(), 1);
  assert.equal(await thread().locator("li.message.captain .body", { hasText: /^Yes$/ }).count(), 2);
});
