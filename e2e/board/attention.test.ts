/// <reference lib="dom" />
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { check, OPS } from "@fleet/protocol";
import type { Cardd, Session } from "../support/cardd.ts";
import { ageCard, ageSession, begin, newCard, oldDatedHold } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

boundBoardFile();

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
beforeEach(async (context) => {
  cardd = await startBoardServer(context, BOARD);
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  main = await cardd.connect(cardd.addLane("main"));
  page = await openBoardPage(context, browser);
});

const open = (): Promise<unknown> =>
  page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));

test("armed waits and a silent worker's live job raise no board alarm, while unattended work does", async () => {
  for (const [title, wait] of [
    ["Review sweep", { watcher: "the review sweep checks approval" }],
    ["Outside checkpoint", { outside: "the November 16 read" }],
  ] as const) {
    const held = await newCard(main, title);
    await main.call("hold", {
      card: held.id,
      question: "Wait for the checkpoint",
      until: Date.now() + 10 * DAY,
      remaining: [],
      ...wait,
    });
    ageCard(cardd, held, 4 * DAY);
  }
  const busy = await newCard(main, "Live ad watch");
  const worker = await cardd.connect(await begin(main, busy));
  const { job, heartbeatMs } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "ad watch", command: "watch ads" }),
  );
  const beat = setInterval(() => {
    worker.call("job.alive", { job }).catch(() => undefined);
  }, heartbeatMs);
  try {
    worker.send({ t: "activity", state: "running" });
    await worker.call("standing", {});
    ageSession(cardd, busy, 10 * 60_000);
    await open();
    await page.getByRole("article", { name: "Live ad watch" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Attention" }).count(), 0);
    assert.equal(await page.locator("p.pulse-line b").count(), 0);
    assert.match(
      (await page
        .getByRole("article", { name: "Live ad watch" })
        .locator("p.pulse-line")
        .textContent()) ?? "",
      /running job \d+ \(ad watch\)/,
    );
    const idle = await newCard(main, "Unattended invoices");
    ageCard(cardd, idle, 25 * HOUR);
    const strip = page.getByRole("region", { name: "Attention" });
    await strip.getByRole("link", { name: /Unattended invoices/ }).waitFor();
    assert.equal(await strip.getByRole("listitem").count(), 1);
    assert.equal(await strip.locator(".what").textContent(), "Idle 1d");
  } finally {
    clearInterval(beat);
    await worker.close();
  }
});

test("the Attention strip lists broken, parked, idle and your cards in that order across projects, and each card says who has it", async (context) => {
  const broken = await newCard(main, "Fix the Cleo rule");
  const failing = await cardd.connect(await begin(main, broken));
  await failing.call("report", { status: "failed", text: "the build is red" });
  const parked = await newCard(main, "Crud ingress bypasses Cloud Armor");
  oldDatedHold(cardd, parked, "main", Date.now(), Date.now() + 10 * DAY);
  ageCard(cardd, parked, 4 * DAY);
  const idle = await newCard(main, "Port the invoices");
  ageCard(cardd, idle, 25 * HOUR);
  const mainsIdle = await newCard(main, "Port the ads");
  ageCard(cardd, mainsIdle, 5 * HOUR);
  await main.call("card.new", { title: "Bitwarden login for the p620 browser", kind: "captain" });
  const running = await newCard(main, "Ship the scrollbar fix");
  const worker = await cardd.connect(await begin(main, running));
  worker.send({ t: "activity", state: "running" });
  await open();

  const strip = page.getByRole("region", { name: "Attention" });
  const items = strip.getByRole("listitem");
  await items.nth(3).waitFor();
  assert.deepEqual(
    await items.evaluateAll((all) => all.map((each) => each.getAttribute("data-state"))),
    ["broken", "parked", "idle", "you"],
  );
  assert.equal(await items.nth(0).locator(".what").textContent(), "Broken");
  assert.equal(await items.nth(1).locator(".what").textContent(), "Parked 4d");
  assert.equal(await items.nth(2).locator(".what").textContent(), "Idle 1d");
  assert.equal(await items.nth(3).locator(".what").textContent(), "Waiting on you");
  assert.match(
    (await items.nth(1).locator(".why").textContent()) ?? "",
    /idle park, nothing running · running nothing/,
  );
  assert.equal(await strip.getByText("Ship the scrollbar fix").count(), 0);
  assert.equal(
    await strip.getByText("Port the ads").count(),
    0,
    "a card idle for 5 hours is main's to hear about, not the captain's",
  );
  assert.deepEqual(await strip.locator(".attention-chip").allTextContents(), [
    "1 broken",
    "1 idle",
    "1 parked",
    "1 waiting on you",
  ]);

  const line = page.getByRole("article", { name: "Port the invoices" }).locator("p.pulse-line");
  assert.equal(
    await line.textContent(),
    "Idle 1d · main · running nothing · moved 1d ago · waits on main",
  );
  const mains = page.getByRole("article", { name: "Port the ads" }).locator("p.pulse-line");
  assert.equal(await mains.textContent(), "main · running nothing · moved 5h ago · waits on main");
  assert.equal(await mains.locator("b").count(), 0, "main's notice raises no alarm on the board");
  const live = page
    .getByRole("article", { name: "Ship the scrollbar fix" })
    .locator("p.pulse-line");
  assert.match((await live.textContent()) ?? "", /^a worker on maverick · running a turn · moved /);
  assert.equal(await live.locator("b").count(), 0, "a running card has no alarm");
  const evidence = process.env["BOARD_EVIDENCE_DIR"];
  if (evidence !== undefined) await page.screenshot({ path: `${evidence}/attention.png` });

  const phone = await openBoardPage(context, browser, { width: 390, height: 844 });
  await phone.goto(page.url());
  await phone.getByRole("region", { name: "Attention" }).getByRole("listitem").nth(3).waitFor();
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `the strip overflows a phone by ${String(overflow)}px`);
  if (evidence !== undefined) await phone.screenshot({ path: `${evidence}/attention-phone.png` });

  await items
    .nth(2)
    .getByRole("link", { name: /Port the invoices/ })
    .click();
  await page.getByRole("heading", { name: "Port the invoices" }).waitFor();
  await page.waitForURL(`**/#/c-${String(idle.id)}`);
});

test("a card's line says what remains behind it, also on a Needs you card whose date has passed", async (context) => {
  const first = await newCard(main, "Capacity proof");
  const second = await newCard(main, "Caller list");
  const waiting = await newCard(main, "Crud ingress lock");
  await main.call("hold", {
    card: waiting.id,
    question: "Wait for the first hub use?",
    until: Date.now() + 10 * DAY,
    outside: "the first real support hub interaction",
    remaining: [first.id, second.id],
  });
  const asked = await newCard(main, "Pick the vendor");
  await main.call("hold", {
    card: asked.id,
    question: "Pick the vendor?",
    until: Date.now() + 1_500,
    outside: "the vendor's quote",
    remaining: [first.id],
  });
  await until(async () => {
    const found = (await cardd.board()).cards.find((card) => card.id === asked.id);
    return found?.pulse?.state === "you" ? true : undefined;
  }, "the date of the hold to pass");
  await open();

  const held = page.getByRole("article", { name: "Crud ingress lock" }).locator("p.pulse-line");
  assert.equal(
    await held.textContent(),
    "you · running nothing · moved just now · 2 steps behind it, none started",
  );
  const yours = page.getByRole("article", { name: "Pick the vendor" }).locator("p.pulse-line");
  assert.equal(
    await yours.textContent(),
    "waiting on you · moved just now · 1 step behind it, none started",
  );
  assert.equal(
    await page
      .getByRole("article", { name: "Capacity proof" })
      .locator("p.pulse-line")
      .textContent(),
    "main · running nothing · moved just now · waits on main",
    "a card with nothing behind it says nothing about steps",
  );

  const phone = await openBoardPage(context, browser, { width: 390, height: 844 });
  await phone.goto(page.url());
  await phone.getByRole("article", { name: "Pick the vendor" }).waitFor();
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `the lines overflow a phone by ${String(overflow)}px`);
});

test("the strip shows five and counts the rest", async () => {
  for (const title of ["One", "Two", "Three", "Four", "Five", "Six", "Seven"]) {
    const card = await newCard(main, `Port ${title}`);
    ageCard(cardd, card, 25 * HOUR);
  }
  await open();
  const strip = page.getByRole("region", { name: "Attention" });
  const items = strip.getByRole("listitem");
  await items.nth(4).waitFor();
  assert.equal(await items.count(), 5);
  await strip.getByRole("button", { name: "2 more" }).click();
  assert.equal(await items.count(), 7);
  await strip.getByRole("button", { name: "Show fewer" }).click();
  assert.equal(await items.count(), 5);
});

test("nothing is flagged for a young card, so there is no strip, and its line says only what is true", async () => {
  await newCard(main, "Port the calendar");
  await open();
  const card = page.getByRole("article", { name: "Port the calendar" });
  await card.waitFor();
  assert.equal(await page.getByRole("region", { name: "Attention" }).count(), 0);
  assert.equal(
    await card.locator("p.pulse-line").textContent(),
    "main · running nothing · moved just now · waits on main",
  );
  assert.equal(await card.locator("p.pulse-line b").count(), 0);
});
