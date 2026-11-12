/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { CardSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Cardd } from "../support/cardd.ts";
import { type Session } from "../support/cardd.ts";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import { seedKanban, type Kanban } from "../support/kanban.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];
const DESKTOP = { width: 1440, height: 900 };
const APPROVE = "Approve & merge";
const ROLL_OPTIONS = ["Merge and roll (recommended)", "Merge only", "Request changes"];
const ROLL_APPROVES = ROLL_OPTIONS.slice(0, 2);
const ROLL_QUESTION = `Merge https://github.com/acme/fleet/pull/51, and then roll it out? Fix path C for the recording machines. Two separate steps: 1. Merge: starts no deploy (egress deploy is manual only). Recommend yes. 2. Staged roll-forward in the 06:00-11:00Z window with a 60-minute recording watch. Recommend yes. Summary: p620:/tmp/fleet-c-1406/final-summary.md`;

boundBoardFile();

let browser: Browser;
let cardd: Cardd;
let main: Session;
let fleet: Kanban;
let page: Page;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});
beforeEach(async (context) => {
  cardd = await startBoardServer(context, BOARD);
  main = await cardd.connect(cardd.addLane("main"));
  fleet = await seedKanban(cardd, main);
  page = await openBoardPage(context, browser, DESKTOP);
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
const region = (name: string): Locator => page.getByRole("region", { name, exact: true });
const card = (title: string): Locator => page.getByRole("article", { name: title });

async function last(card: string, kind: string): Promise<Entry> {
  const entries = (await cardd.thread(fleet.cards[card]?.id ?? 0)).entries;
  const found = entries.findLast((entry) => entry.kind === kind);
  assert.ok(found, `c-${card} has a ${kind}`);
  return found;
}

async function shoot(name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function open(): Promise<void> {
  await page.goto(http());
  await region("Needs you").getByRole("article").first().waitFor();
}

test("Needs you: Approve & merge moves the card to Merging as the captain's approval", async () => {
  await open();
  const title = "Board: thread as a story, steers fold away";
  await card(title).getByRole("button", { name: APPROVE }).click();
  await region("Merging")
    .getByRole("article", { name: title })
    .getByText("you approved · landing")
    .waitFor();
  assert.equal(await region("Needs you").getByRole("article", { name: title }).count(), 0);
  const answer = await last("merge", "answer");
  assert.deepEqual([answer.fields["choice"], answer.fields["approved"]], [APPROVE, true]);
});

test("Needs you: the fleet's own merge question offers Approve & merge and his own words, and his words go to main and approve nothing", async () => {
  await open();
  const title = "Board: thread as a story, steers fold away";
  const asked = card(title);
  assert.equal(await asked.getByRole("button", { name: "Request changes" }).count(), 0);
  await asked.getByRole("button", { name: "Your words" }).click();
  await asked.getByText("Your answer").waitFor();
  const send = asked.getByRole("button", { name: "Send answer" });
  assert.equal(await send.isDisabled(), true);
  await shoot("merge-words-1440");

  const words = "Keep the CI failure line, but fold the rerun into it";
  await asked.getByRole("textbox", { name: "Your words" }).fill(words);
  await send.click();
  await region("In progress")
    .getByRole("article", { name: title })
    .locator(".chip", { hasText: "with main" })
    .waitFor();
  const heard = await last("merge", "comment");
  assert.deepEqual(
    [heard.author, heard.body, heard.fields["written"], heard.fields["source"]],
    ["captain", words, true, "board"],
  );
  const entries = (await cardd.thread(fleet.cards["merge"]?.id ?? 0)).entries;
  assert.equal(
    entries.some((entry) => entry.kind === "answer"),
    false,
  );
  assert.equal(await region("Merging").getByRole("article", { name: title }).count(), 0);
});

async function rewrittenMergeAsk(title: string): Promise<Card> {
  const created = check(
    CardSchema,
    await main.call("card.new", { title, kind: "ship", project: "fleet" }),
  );
  const began = await main.call("attempt.begin", {
    card: created.id,
    host: "maverick",
    task: title,
  });
  const worker = await cardd.connect(check(OPS["attempt.begin"].result, began).token);
  const url = "https://github.com/acme/fleet/pull/51";
  await worker.call("report", { status: "done", text: "PR green and ready", pr: url });
  await main.call("hold", {
    card: created.id,
    question: ROLL_QUESTION,
    options: ROLL_OPTIONS,
    approves: ROLL_APPROVES,
  });
  return created;
}

test("Needs you: a merge question the mate rewrote shows his question and options, laid out, and an approving option approves", async () => {
  const title = "Repair the recording egress group";
  const created = await rewrittenMergeAsk(title);
  await open();
  const asked = card(title);
  await asked.getByText(/Fix path C for the recording machines/).waitFor();
  assert.deepEqual(await asked.locator(".option").allTextContents(), ROLL_OPTIONS);
  await shoot("rewritten-merge-card-1440");

  await asked.getByRole("button", { name: "Read" }).click();
  const detail = page.getByRole("region", { name: "Waiting for you" });
  const text = await detail.locator(".ask-text").innerText();
  assert.match(text, /\n\n1\. Merge: starts no deploy/);
  assert.match(text, /\n2\. Staged roll-forward/);
  assert.match(text, /Summary:\np620:\/tmp\/fleet-c-1406\/final-summary\.md$/);
  await shoot("rewritten-merge-detail-1440");

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("button", { name: "Fleet" })
    .click();
  await asked.getByRole("button", { name: "Merge only" }).click();
  await region("Merging")
    .getByRole("article", { name: title })
    .getByText("you approved · landing")
    .waitFor();
  const answer = (await cardd.thread(created.id)).entries.findLast((e) => e.kind === "answer");
  assert.deepEqual(
    [answer?.fields["choice"], answer?.fields["approved"], answer?.fields["source"]],
    ["Merge only", true, "board"],
  );
});

test("Needs you: an option a rewritten merge question does not name in approves is accepted and goes to main, and nothing is approved", async () => {
  const title = "Repair the recording egress group";
  const created = await rewrittenMergeAsk(title);
  await open();
  await card(title).getByRole("button", { name: "Request changes" }).click();
  await region("In progress")
    .getByRole("article", { name: title })
    .locator(".chip", { hasText: "with main" })
    .waitFor();
  const entries = (await cardd.thread(created.id)).entries;
  assert.equal(
    entries.some((entry) => entry.kind === "answer"),
    false,
  );
  const heard = entries.findLast((entry) => entry.kind === "comment");
  assert.deepEqual(
    [heard?.author, heard?.body, heard?.fields["choice"]],
    ["captain", "Request changes", "Request changes"],
  );
  assert.equal(await region("Merging").getByRole("article", { name: title }).count(), 0);
});
