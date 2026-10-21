/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { Cardd, type Session } from "../support/cardd.ts";
import { seedKanban, type Kanban } from "../support/kanban.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];

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
beforeEach(async () => {
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.001" }, ["--board", BOARD]);
  main = await cardd.connect(cardd.addLane("main"));
  fleet = await seedKanban(cardd, main);
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
});
afterEach(async () => {
  await page.close();
  await cardd.stop();
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
const card = (title: string): Locator => page.getByRole("article", { name: title });

async function shoot(name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function open(): Promise<void> {
  await page.goto(http());
  await page.getByRole("region", { name: "Needs you" }).getByRole("article").first().waitFor();
}

test("card numbers read #N everywhere the board shows one, and URLs and card references in text are links", async () => {
  const merge = fleet.cards["merge"];
  const question = fleet.cards["question"];
  assert.ok(merge && question);
  await main.call("hold", {
    card: question.id,
    question: `Does https://github.com/acme/web/pull/2456. fix c-${String(merge.id)}? See (https://example.com/a_(b)).`,
    options: ["Yes", "No"],
  });
  await open();
  await shoot("hold-links-1440");
  const tile = card("Vehicle acquisition: a passed lead stops Cleo's emails");
  await tile.locator(".idrow .id", { hasText: `#${String(question.id)}` }).waitFor();
  const text = await page.locator("main").innerText();
  assert.equal(/\bc-\d+\b/.test(text), false, "no c-N on the board");
  assert.equal(text.includes(`#${String(merge.id)}`), true);

  const link = tile.getByRole("link", { name: "https://github.com/acme/web/pull/2456" });
  assert.equal(await link.getAttribute("href"), "https://github.com/acme/web/pull/2456");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noreferrer");
  await tile.getByRole("link", { name: "https://example.com/a_(b)" }).waitFor();
  assert.equal(
    await tile.getByRole("link", { name: `#${String(merge.id)}` }).getAttribute("href"),
    `#/c-${String(merge.id)}`,
  );

  await page.goto(`${http()}#/c-${String(question.id)}`);
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  await waiting.getByRole("link", { name: "https://github.com/acme/web/pull/2456" }).waitFor();
  assert.equal(await page.locator(".card-id").innerText(), `#${String(question.id)}`);
  assert.equal((await page.title()).startsWith(`#${String(question.id)} `), true);

  await page.goto(`${http()}#/c-${String(merge.id)}`);
  const pr = page.getByRole("link", { name: "fleet#39" });
  assert.equal(await pr.getAttribute("href"), "https://github.com/acme/fleet/pull/39");
  assert.equal(await pr.getAttribute("target"), "_blank");
  await page.goto(`${http()}#/c-999`);
  await page.getByText("#999 is not on the board.").waitFor();
});
