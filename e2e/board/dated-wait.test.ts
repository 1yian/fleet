import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import type { Cardd, Session } from "../support/cardd.ts";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

boundBoardFile();

let browser: Browser;
let cardd: Cardd;
let cleo: Session;
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
  cardd.addLane("main");
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  page = await openBoardPage(context, browser);
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

async function workerOn(title: string): Promise<{ card: Card; worker: Session }> {
  const card = check(
    CardSchema,
    await cleo.call("card.new", { title, kind: "ship", project: "web" }),
  );
  const begun = await cleo.call("attempt.begin", { card: card.id, host: "maverick", task: title });
  const { token } = check(OPS["attempt.begin"].result, begun);
  return { card, worker: await cardd.connect(token) };
}

const DATED = /\d{2}:\d{2}/;
const region = (name: string): Locator => page.getByRole("region", { name, exact: true });
const property = (name: string): Locator =>
  page
    .locator(".property")
    .filter({ has: page.getByText(name, { exact: true }) })
    .locator("dd");

test("a card held until a date and a worker paused until a date show their dates in the lists and in the card, and never read blocked", async () => {
  const held = await workerOn("Pick the load balancer");
  await held.worker.call("report", { status: "blocked", text: "waiting for the load balancer" });
  await cleo.call("hold", {
    card: held.card.id,
    question: "Wait for the load balancer?",
    until: Date.now() + 2 * DAY,
  });
  const paused = await workerOn("Wait for the CI run");
  await paused.worker.call("report", {
    status: "paused",
    text: "CI runs",
    until: Date.now() + HOUR,
  });

  await page.goto(http());
  const waiting = region("Up next").getByRole("article", { name: held.card.title });
  await waiting.locator(".chip", { hasText: DATED }).waitFor();
  const pausedCard = region("In progress").getByRole("article", { name: paused.card.title });
  await pausedCard.locator(".chip", { hasText: /^paused until (?:\S+ )?\d{2}:\d{2}$/ }).waitFor();
  assert.doesNotMatch(await waiting.innerText(), /blocked/i);

  await page.goto(`${http()}#/c-${String(held.card.id)}`);
  await property("Status").filter({ hasText: "On hold" }).waitFor();
  assert.equal(await property("Status").innerText(), "On hold");
  assert.match(await property("Until").innerText(), /\d{2}:\d{2}$/);

  await page.goto(`${http()}#/c-${String(paused.card.id)}`);
  await property("Status").filter({ hasText: "Paused" }).waitFor();
  assert.equal(await property("Status").innerText(), "Paused");
  assert.match(await property("Until").innerText(), /^(?:\S+ )?\d{2}:\d{2}$/);
});
