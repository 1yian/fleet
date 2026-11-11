/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { CardSchema, check, MERGE_OPTIONS, type Card, type Entry } from "@fleet/protocol";
import type { Cardd, Session } from "../support/cardd.ts";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import { seedKanban, type Kanban } from "../support/kanban.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];
const DESKTOP = { width: 1440, height: 900 };
const EXAMPLES = "tomorrow, Friday 4PM, 4PM CST, Nov 20, or in 2 hours";
const TOKYO = "Asia/Tokyo";
const TOKYO_AHEAD_MS = 9 * 3_600_000;
const SIMPLE = "Pick the API version";

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
  page = await openBoardPage(context, browser, DESKTOP, TOKYO);
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
  await region("Needs you").getByRole("article").first().waitFor();
});

const region = (name: string): Locator => page.getByRole("region", { name, exact: true });
const card = (title: string): Locator => page.getByRole("article", { name: title });
const later = (title: string): Locator => card(title).getByRole("group", { name: "Ask me later" });
const until = (title: string): Locator => later(title).getByRole("textbox", { name: "Until when" });

async function shoot(name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function entriesOf(id: number): Promise<Entry[]> {
  return (await cardd.thread(id)).entries;
}

async function lastHold(id: number): Promise<Entry> {
  const found = (await entriesOf(id)).findLast((entry) => entry.kind === "hold");
  assert.ok(found, `c-${String(id)} has a hold`);
  return found;
}

const idOf = (name: string): number => fleet.cards[name]?.id ?? 0;

async function openLater(title: string): Promise<void> {
  await card(title).getByRole("button", { name: "Later" }).click();
  await until(title).waitFor();
}

test("Later takes the words he types and reads a bare time in the zone of his browser", async () => {
  await openLater(SIMPLE);
  const box = until(SIMPLE);
  assert.equal(await box.getAttribute("placeholder"), "Friday 4PM, Nov 20, in 2 hours");
  await later(SIMPLE).getByText(`read in ${TOKYO}`).waitFor();
  await shoot("later-box-1440");

  await box.fill("Dec 31 2099 4PM");
  await box.press("Enter");
  await region("Up next").getByRole("article", { name: SIMPLE }).waitFor();
  assert.equal(await region("Needs you").getByRole("article", { name: SIMPLE }).count(), 0);
  const held = page.getByRole("status");
  await held
    .getByText(
      `c-${String(idOf("simple"))} comes back to you Thu, Dec 31, 2099, 4:00 PM GMT+9 (${TOKYO})`,
      { exact: true },
    )
    .waitFor();
  await shoot("later-held-1440");

  const hold = await lastHold(idOf("simple"));
  assert.equal(hold.author, "captain");
  assert.equal(hold.fields["until"], Date.UTC(2099, 11, 31, 7, 0));
  assert.deepEqual(hold.fields["wait"], { by: "later", text: "Dec 31 2099 4PM" });
  assert.equal(hold.body, "Which API version ships?");
});

test("a zone in his words wins over the zone of his browser", async () => {
  const title = "Vehicle acquisition: a passed lead stops Cleo's emails";
  await openLater(title);
  await until(title).fill("Dec 31 2099 4PM CST");
  await later(title).getByRole("button", { name: "Hold until then" }).click();
  await region("Up next").getByRole("article", { name: title }).waitFor();
  await page
    .getByRole("status")
    .getByText(
      `c-${String(idOf("question"))} comes back to you Thu, Dec 31, 2099, 4:00 PM CST (America/Chicago)`,
      { exact: true },
    )
    .waitFor();
  const hold = await lastHold(idOf("question"));
  assert.equal(hold.fields["until"], Date.UTC(2099, 11, 31, 22, 0));
  assert.deepEqual(hold.fields["wait"], { by: "later", text: "Dec 31 2099 4PM CST" });
});

test("a zone he names that the reader does not know is refused in the Later box with what to use, and what he typed stays there", async () => {
  await openLater(SIMPLE);
  const box = until(SIMPLE);
  const before = await entriesOf(idOf("simple"));
  await box.fill("Dec 31 2099 4PM CHT");
  await box.press("Enter");

  const problem = later(SIMPLE).getByRole("alert");
  await problem.getByText("CHT is not a time zone the reader knows", { exact: false }).waitFor();
  await problem.getByText("Europe/Paris", { exact: false }).waitFor();
  await problem.getByText("UTC+2", { exact: false }).waitFor();
  assert.equal(await box.inputValue(), "Dec 31 2099 4PM CHT");
  assert.deepEqual(await entriesOf(idOf("simple")), before);
  assert.equal(await region("Needs you").getByRole("article", { name: SIMPLE }).count(), 1);

  await box.fill("Dec 31 2099 4PM GMT+abc");
  await box.press("Enter");
  await problem
    .getByText("GMT+abc is not a time zone the reader knows", { exact: false })
    .waitFor();
  assert.equal(await box.inputValue(), "Dec 31 2099 4PM GMT+abc");
  assert.deepEqual(await entriesOf(idOf("simple")), before);
  assert.equal(await region("Needs you").getByRole("article", { name: SIMPLE }).count(), 1);
});

test("a time in a zone he names holds the card, and the notice shows the resolved time and zone", async () => {
  await openLater(SIMPLE);
  await until(SIMPLE).fill("Dec 31 2099 4PM CET");
  await until(SIMPLE).press("Enter");
  await region("Up next").getByRole("article", { name: SIMPLE }).waitFor();
  await page
    .getByRole("status")
    .getByText(
      `c-${String(idOf("simple"))} comes back to you Thu, Dec 31, 2099, 4:00 PM GMT+1 (Europe/Paris)`,
      { exact: true },
    )
    .waitFor();
  const paris = await lastHold(idOf("simple"));
  assert.equal(paris.fields["until"], Date.UTC(2099, 11, 31, 15, 0));
  assert.deepEqual(paris.fields["wait"], { by: "later", text: "Dec 31 2099 4PM CET" });

  const title = "Vehicle acquisition: a passed lead stops Cleo's emails";
  await openLater(title);
  await until(title).fill("Dec 31 2099 4PM UTC+2");
  await until(title).press("Enter");
  await region("Up next").getByRole("article", { name: title }).waitFor();
  await page
    .getByRole("status")
    .getByText(
      `c-${String(idOf("question"))} comes back to you Thu, Dec 31, 2099, 4:00 PM GMT+2 (+02:00)`,
      { exact: true },
    )
    .waitFor();
  const offset = await lastHold(idOf("question"));
  assert.equal(offset.fields["until"], Date.UTC(2099, 11, 31, 14, 0));
  assert.deepEqual(offset.fields["wait"], { by: "later", text: "Dec 31 2099 4PM UTC+2" });
});

test("text with no time is refused in the Later box, and what he typed stays there", async () => {
  await openLater(SIMPLE);
  const box = until(SIMPLE);
  const before = await entriesOf(idOf("simple"));
  await box.fill("after the demo");
  await box.press("Enter");

  const problem = later(SIMPLE).getByRole("alert");
  await problem.getByText('No time in "after the demo"').waitFor();
  await problem.getByText(EXAMPLES, { exact: false }).waitFor();
  assert.equal(await box.inputValue(), "after the demo");
  await shoot("later-refused-1440");
  assert.deepEqual(await entriesOf(idOf("simple")), before);
  assert.equal(await region("Needs you").getByRole("article", { name: SIMPLE }).count(), 1);

  await box.fill("tomorrow 9am");
  await box.press("Enter");
  await region("Up next").getByRole("article", { name: SIMPLE }).waitFor();
  const hold = await lastHold(idOf("simple"));
  assert.deepEqual(hold.fields["wait"], { by: "later", text: "tomorrow 9am" });
});

test("a preset sends the same words through the same path", async () => {
  await card(SIMPLE).getByRole("button", { name: "Later" }).click();
  await later(SIMPLE).getByRole("button", { name: "Tomorrow 09:00" }).click();
  await region("Up next").getByRole("article", { name: SIMPLE }).waitFor();
  const tomorrow = new Date(Date.now() + TOKYO_AHEAD_MS);
  const nineInTokyo = Date.UTC(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth(),
    tomorrow.getUTCDate() + 1,
  );
  const hold = await lastHold(idOf("simple"));
  assert.equal(hold.fields["until"], nineInTokyo);
  assert.deepEqual(hold.fields["wait"], { by: "later", text: "tomorrow 09:00" });
});

async function noOptions(): Promise<{ card: Card; title: string }> {
  const title = "Name the new lane";
  const made = check(CardSchema, await main.call("card.new", { title, kind: "captain" }));
  await main.call("hold", { card: made.id, question: "What should the lane be called?" });
  return { card: made, title };
}

test("every kind of decision offers his own words and Later: a hold with options, one with none, and a merge question", async () => {
  const bare = await noOptions();
  await page.reload();
  await card(bare.title).waitFor();
  const kinds = [
    { title: SIMPLE, id: idOf("simple"), open: "Your words" },
    { title: bare.title, id: bare.card.id, open: "Your words" },
    {
      title: "Board: thread as a story, steers fold away",
      id: idOf("merge"),
      open: MERGE_OPTIONS[1],
    },
  ];
  for (const kind of kinds) {
    const asked = card(kind.title);
    await asked.getByRole("button", { name: "Later" }).waitFor();
    await asked.getByRole("button", { name: kind.open, exact: true }).click();
    const words = asked.getByRole("textbox", { name: "Your words" });
    await words.fill(`Neither: ask ${String(kind.id)} again after the audit`);
    await asked.getByRole("button", { name: "Send answer" }).click();
    await words.waitFor({ state: "detached" });
    const answer = (await entriesOf(kind.id)).findLast((entry) => entry.kind === "answer");
    assert.equal(answer?.body, `Neither: ask ${String(kind.id)} again after the audit`);
    assert.equal(answer.fields["written"], true);
  }
});
