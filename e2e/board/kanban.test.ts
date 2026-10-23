/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { BoardActionSchema, check, MERGE_OPTIONS, OPS, type Entry } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { freezeBoardUntilAction } from "../support/board.ts";
import { seedKanban, type Kanban } from "../support/kanban.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

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
  assert.ok("after" in context);
  const server = await Cardd.start({}, ["--board", BOARD]);
  context.after(() => server.stop());
  cardd = server;
  main = await cardd.connect(cardd.addLane("main"));
  fleet = await seedKanban(cardd, main);
  const tab = await browser.newPage({ viewport: DESKTOP });
  context.after(() => tab.close());
  page = tab;
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
const region = (name: string): Locator => page.getByRole("region", { name, exact: true });
const lane = (project: string): Locator => region(project);
const cellOf = (project: string, column: string): Locator =>
  lane(project).getByRole("region", { name: column, exact: true });
const titlesIn = (project: string, column: string): Promise<string[]> =>
  cellOf(project, column).locator(".title").allTextContents();
const titles = (name: string): Promise<string[]> =>
  region(name).locator(".title").allTextContents();
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
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    fullPage: PHONE.width === page.viewportSize()?.width,
  });
}

async function open(): Promise<void> {
  await page.goto(http());
  await region("Needs you").getByRole("article").first().waitFor();
}

const sideways = (): Promise<string[]> =>
  page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll("body *")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .filter((element) => !["hidden", "clip"].includes(getComputedStyle(element).overflowX))
      .map((element) => element.className || element.tagName),
  );

test("desktop: one swimlane for each project, and each card in the cell of its project and status", async () => {
  await open();
  await region("Merging").getByRole("article").nth(1).waitFor();
  await region("Done today").getByRole("article").nth(2).waitFor();

  assert.deepEqual(await page.locator(".swimlane .lane-head h2").allTextContents(), [
    "fleet",
    "No project",
    "calls",
  ]);
  assert.deepEqual(await page.locator(".col-head .name").allTextContents(), [
    "Up next",
    "In progress",
    "Needs you",
    "Merging",
    "Done today",
  ]);
  assert.deepEqual(await titlesIn("fleet", "Up next"), ["Board: kanban columns from card status"]);
  assert.deepEqual((await titlesIn("fleet", "In progress")).toSorted(), [
    "Ban comments in code: a lint rule fails on any comment",
    "Short fleet messages: one line, details on the card",
  ]);
  assert.deepEqual(await titlesIn("fleet", "Needs you"), [
    "Board: thread as a story, steers fold away",
  ]);
  assert.deepEqual(await titlesIn("fleet", "Merging"), [
    "Memory e2e expects fleet messages labelled once",
  ]);
  assert.deepEqual(await titlesIn("fleet", "Done today"), ["Workers start on Pi's default model"]);

  assert.deepEqual(await titlesIn("calls", "Up next"), ["Leo: rotate the Twilio webhook secret"]);
  assert.deepEqual(await titlesIn("calls", "In progress"), [
    "Cleo: merge duplicate leads from the nightly import",
  ]);
  assert.deepEqual(await titlesIn("calls", "Merging"), [
    "Leo: let date of birth be used on a call",
  ]);
  assert.deepEqual(await titlesIn("calls", "Done today"), ["Leo: ship the call recording banner"]);
  assert.equal(await cellOf("calls", "Needs you").getByRole("article").count(), 0);

  assert.deepEqual(await titlesIn("No project", "Up next"), [
    "Renew the leo-calls TLS certificate",
  ]);
  assert.deepEqual(await titlesIn("No project", "Needs you"), [
    "Vehicle acquisition: a passed lead stops Cleo's emails",
    "Pick the API version",
  ]);
  assert.deepEqual(await titlesIn("No project", "Done today"), ["Scope a Linear-style board"]);
  await card("Renew the leo-calls TLS certificate")
    .locator(".chip", { hasText: /\d{2}:\d{2}/ })
    .waitFor();
  assert.equal(
    await cellOf("No project", "Up next").getByText("Later", { exact: true }).count(),
    1,
  );

  const progress = cellOf("fleet", "In progress");
  await progress.locator(".chip", { hasText: "validating" }).waitFor();
  assert.equal(
    await cellOf("calls", "In progress").locator(".chip", { hasText: "with cleo" }).count(),
    1,
  );
  assert.equal(await page.getByText("3 for you").count(), 1);
  assert.deepEqual(await sideways(), []);
  await shoot("desktop-1440");
});

function measureLanes(lanes: readonly Element[]) {
  return lanes.map((element) => {
    const box = element.getBoundingClientRect();
    const cards = [...element.querySelectorAll("article")].map((each) =>
      each.getBoundingClientRect(),
    );
    return {
      name: element.getAttribute("aria-label"),
      top: box.top,
      bottom: box.bottom,
      border: getComputedStyle(element).borderTopWidth,
      outside: cards.filter((at) => at.top < box.top || at.bottom > box.bottom).length,
    };
  });
}

test("desktop: lanes are physically separate, each with its name, and cards stay inside their own lane", async () => {
  await open();
  await region("Merging").getByRole("article").nth(1).waitFor();
  const boxes = await page.locator(".swimlane").evaluateAll(measureLanes);
  assert.deepEqual(
    boxes.map((box) => box.name),
    ["fleet", "No project", "calls"],
  );
  for (const [i, box] of boxes.entries()) {
    assert.equal(box.outside, 0, `${box.name ?? ""} holds its cards`);
    assert.equal(box.border, "1px");
    const next = boxes[i + 1];
    if (next !== undefined) assert.ok(next.top - box.bottom >= 8, "a gap between lanes");
  }
  await lane("No project").getByRole("article", { name: "Pick the API version" }).waitFor();
  assert.equal(
    await lane("fleet").getByRole("article", { name: "Pick the API version" }).count(),
    0,
  );
  await shoot("swimlanes-1440");
});

test("filtering to one mate hides the projects that mate has no cards in", async () => {
  await open();
  assert.equal(await lane("calls").count(), 1);
  await page
    .getByRole("navigation", { name: "Lanes" })
    .getByRole("button", { name: "main" })
    .click();
  assert.equal(await lane("calls").count(), 0);
  assert.equal(await lane("fleet").count(), 1);
});

test("a card has no avatar, and its id row says its kind and its lane", async () => {
  await open();
  await region("Merging").getByRole("article").nth(1).waitFor();
  assert.equal(await page.locator("article.card .av").count(), 0);
  assert.equal(
    await card("Cleo: merge duplicate leads from the nightly import")
      .locator(".idrow .what")
      .innerText(),
    "ship · cleo",
  );
});

test("activity: a card shows what its agent is doing now, live, and its Activity heading says the same", async () => {
  const queued = fleet.cards["queued"];
  assert.ok(queued);
  const begun = await main.call("attempt.begin", { card: queued.id, host: "maverick", task: "go" });
  const worker = await cardd.connect(check(OPS["attempt.begin"].result, begun).token);
  await open();
  const title = "Board: kanban columns from card status";
  const chip = card(title).locator(".chip.live");
  await chip.getByText("idle", { exact: true }).waitFor();

  worker.send({ t: "activity", state: "running" });
  await chip.getByText("running", { exact: true }).waitFor();
  assert.equal(await chip.evaluate((el) => el.classList.contains("running")), true);
  await shoot("activity-running-1440");

  worker.send({ t: "activity", state: "waiting" });
  await chip.getByText("waiting on a job").waitFor();

  await card(title).getByRole("link", { name: title }).click();
  const head = page.locator(".activity-head");
  await head.getByText("waiting on a job").waitFor();
  worker.send({ t: "activity", state: "running" });
  await head.getByText("running", { exact: true }).waitFor();
  await shoot("activity-detail-1440");

  await worker.close();
  await head.getByText("disconnected").waitFor();
});

test("activity: a second mate's row in the rail shows whether it is running", async () => {
  await open();
  const row = region("Mates").getByRole("article", { name: "cleo" });
  await row.getByText("idle", { exact: true }).waitFor();
  fleet.cleo.send({ t: "activity", state: "running" });
  await row.getByText("running", { exact: true }).waitFor();
});

test("desktop: a card shows one SVG status icon, and no sparkles remain", async () => {
  await open();
  const needs = card("Pick the API version");
  assert.equal(await needs.locator("svg.status-icon").count(), 1);
  assert.equal(await page.locator(".sparkle").count(), 0);
  const kinds = await page
    .locator("svg.status-icon")
    .evaluateAll((icons) =>
      [...new Set(icons.map((icon) => icon.getAttribute("class")?.split(" ").at(-1)))].toSorted(),
    );
  assert.deepEqual(
    kinds,
    [
      "si-dropped",
      "si-done",
      "si-later",
      "si-merging",
      "si-mate",
      "si-needs",
      "si-queued",
      "si-review",
      "si-working",
    ].toSorted(),
  );
});

test("desktop: Done today says merged, merged automatically with yolo, and done for a scout", async () => {
  await open();
  const done = region("Done today");
  assert.deepEqual((await titles("Done today")).toSorted(), [
    "Leo: ship the call recording banner",
    "Scope a Linear-style board",
    "Workers start on Pi's default model",
  ]);
  await done
    .getByRole("article", { name: "Workers start on Pi's default model" })
    .getByText("Merged", { exact: true })
    .waitFor();
  await done
    .getByRole("article", { name: "Leo: ship the call recording banner" })
    .getByText("Merged automatically")
    .waitFor();
  await done
    .getByRole("article", { name: "Scope a Linear-style board" })
    .getByText("Done", { exact: true })
    .waitFor();
  await region("Merging").getByText("merging automatically").waitFor();
  await region("Merging").getByText("you approved · landing").waitFor();
});

test("the rail holds Dropped, older Done, and the Mates, and lane chips filter the board", async () => {
  await open();
  const hidden = region("Hidden columns");
  await hidden.getByRole("button", { name: /Dropped/ }).click();
  await hidden
    .getByRole("article", { name: "Try the dock" })
    .getByText("Dropped", { exact: true })
    .waitFor();
  await hidden.getByRole("button", { name: /Older done/ }).click();
  await hidden.getByRole("article", { name: "Migrate the live cardd" }).waitFor();
  assert.equal(await region("Done today").getByText("Migrate the live cardd").count(), 0);

  const mates = region("Mates");
  assert.deepEqual(await mates.locator(".title").allTextContents(), ["cleo", "leo"]);

  const lanes = page.getByRole("navigation", { name: "Lanes" });
  await lanes.getByRole("button", { name: "leo", exact: true }).click();
  assert.deepEqual(await titles("Up next"), [
    "Leo: rotate the Twilio webhook secret",
    "Renew the leo-calls TLS certificate",
  ]);
  assert.equal(await region("Needs you").getByRole("article").count(), 0);
  assert.equal(await mates.getByRole("article").count(), 2);
  await lanes.getByRole("button", { name: "All lanes" }).click();
  await region("Needs you").getByRole("article").first().waitFor();
});

test("Needs you: a long question clamps to two lines with a Read link that opens the card", async () => {
  await open();
  const asked = card("Vehicle acquisition: a passed lead stops Cleo's emails");
  const text = asked.locator(".ask-text");
  const lines = await text.evaluate(
    (element) =>
      element.getBoundingClientRect().height /
      Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  assert.ok(Math.round(lines) <= 2, `${String(lines)} lines`);
  assert.equal(await card("Pick the API version").getByRole("button", { name: "Read" }).count(), 0);
  const options = await asked.locator(".option").allTextContents();
  assert.deepEqual(options.slice(0, 3), ["Fix both", "Fix R1 only", "Ship as is"]);

  await asked.getByRole("button", { name: "Read" }).click();
  await page
    .getByRole("region", { name: "Waiting for you" })
    .getByText(/the extra work is R1 only/)
    .waitFor();
});

test("Needs you: one click on an option answers, and the card goes to its owner", async () => {
  await open();
  await card("Pick the API version").getByRole("button", { name: "v2" }).click();
  await region("In progress")
    .getByRole("article", { name: "Pick the API version" })
    .locator(".chip", { hasText: "with main" })
    .waitFor();
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.deepEqual(
    [answer.author, answer.body, answer.fields["source"]],
    ["captain", "v2", "board"],
  );
  assert.equal(await region("Needs you").getByRole("article").count(), 2);
  await page.getByText("2 for you").waitFor();
});

test("Needs you: Approve & merge moves the card to Merging as the captain's approval", async () => {
  await open();
  const title = "Board: thread as a story, steers fold away";
  await card(title).getByRole("button", { name: MERGE_OPTIONS[0] }).click();
  await region("Merging")
    .getByRole("article", { name: title })
    .getByText("you approved · landing")
    .waitFor();
  assert.equal(await region("Needs you").getByRole("article", { name: title }).count(), 0);
  const answer = await last("merge", "answer");
  assert.equal(answer.fields["choice"], MERGE_OPTIONS[0]);
});

test("Needs you: Request changes asks for words in the card, and sending sends them to the worker", async () => {
  await open();
  const title = "Board: thread as a story, steers fold away";
  const asked = card(title);
  await asked.getByRole("button", { name: MERGE_OPTIONS[1] }).click();
  await asked.getByText("What should change before it merges?").waitFor();
  assert.equal(
    (await cardd.thread(fleet.cards["merge"]?.id ?? 0)).entries.some(
      (entry) => entry.kind === "answer",
    ),
    false,
  );
  const send = asked.getByRole("button", { name: "Send answer" });
  assert.equal(await send.isDisabled(), true);
  await shoot("request-changes-1440");

  await asked
    .getByRole("textbox", { name: "Your words" })
    .fill("Keep the CI failure line, but fold the rerun into it");
  await send.click();
  await region("In progress").getByRole("article", { name: title }).waitFor();
  const answer = await last("merge", "answer");
  assert.equal(answer.body, "Keep the CI failure line, but fold the rerun into it");
  assert.equal(answer.fields["choice"], MERGE_OPTIONS[1]);
  assert.equal(answer.fields["written"], true);
});

test("Needs you: Cancel closes the words box and leaves the options", async () => {
  await open();
  const asked = card("Pick the API version");
  await asked.getByRole("button", { name: "Your words" }).click();
  await asked.getByRole("textbox", { name: "Your words" }).press("Escape");
  await asked.getByRole("button", { name: "Your words" }).waitFor();
  assert.equal(new URL(page.url()).hash, "");
});

test("Needs you: Later uses the hold action and the card moves to Later in Up next", async () => {
  await open();
  const title = "Pick the API version";
  const asked = card(title);
  await asked.getByRole("button", { name: "Later" }).click();
  await asked.getByRole("button", { name: "Tomorrow 09:00" }).click();
  await region("Up next").getByRole("article", { name: title }).waitFor();
  assert.equal(await region("Needs you").getByRole("article", { name: title }).count(), 0);
  const hold = await last("simple", "hold");
  assert.equal(hold.author, "captain");
  const until = hold.fields["until"];
  assert.equal(typeof until === "number" && until > Date.now(), true);
  await region("Up next")
    .getByRole("article", { name: title })
    .locator(".chip", { hasText: /\d{2}:\d{2}/ })
    .waitFor();
});

test("Needs you: a click on a card that changed shows a notice in that card and sends nothing", async () => {
  const snapshot = await cardd.board();
  await freezeBoardUntilAction(page, snapshot);
  await open();
  const title = "Pick the API version";
  const id = fleet.cards["simple"]?.id ?? 0;
  const shown = snapshot.cards.find((each) => each.id === id);
  const held = snapshot.holds.find((each) => each.card === id);
  assert.ok(shown && held);
  await main.call("hold", {
    card: id,
    question: "Which API version ships now?",
    options: ["v1", "v2"],
  });
  const [response] = await Promise.all([
    page.waitForResponse((each) => each.url().endsWith("/api/action")),
    card(title).getByRole("button", { name: "v2" }).click(),
  ]);
  const sent: unknown = response.request().postDataJSON();
  assert.deepEqual(check(BoardActionSchema, sent), {
    card: id,
    revision: shown.revision,
    action: { kind: "answer", hold: held.hold, choice: "v2" },
  });
  assert.equal(response.status(), 409);
  const stale = card(title).getByRole("alert");
  await stale.getByText(`#${String(id)} changed since you looked`).waitFor();
  await stale.getByText("Nothing was sent").waitFor();
  assert.equal(main.entries.filter(({ entry }) => entry.kind === "answer").length, 0);
  assert.equal(await page.getByRole("alert").count(), 1);
  await shoot("stale-1440");
});

test("phone: a list with Needs you first, in the same vocabulary, and nothing scrolls sideways", async () => {
  await page.setViewportSize(PHONE);
  await open();
  await region("Done today").getByRole("article").nth(2).waitFor();

  const order = await lane("fleet")
    .locator("section.cell")
    .evaluateAll((sections) =>
      sections
        .map((section) => ({
          name: section.getAttribute("aria-label"),
          top: section.getBoundingClientRect().top,
        }))
        .toSorted((a, b) => a.top - b.top)
        .map((section) => section.name),
    );
  assert.deepEqual(order, ["Needs you", "In progress", "Merging", "Up next", "Done today"]);
  const needs = card("Pick the API version");
  await needs.getByRole("button", { name: "v1" }).waitFor();
  const row = await card("Short fleet messages: one line, details on the card").boundingBox();
  assert.ok(row !== null && row.height < 56, `a row is ${String(row?.height)} px`);
  assert.equal(
    await card("Short fleet messages: one line, details on the card").locator(".idrow").isVisible(),
    false,
  );
  const option = await needs.getByRole("button", { name: "v1" }).boundingBox();
  assert.ok(option !== null && option.height >= 40, "a touch target");
  assert.deepEqual(await sideways(), []);
  await shoot("phone-390");

  await needs.getByRole("button", { name: "v2" }).click();
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "v2");
});
