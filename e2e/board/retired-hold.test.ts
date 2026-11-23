/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { CardSchema, check, type Card } from "@fleet/protocol";
import type { Cardd, Session } from "../support/cardd.ts";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];

boundBoardFile();

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
beforeEach(async (context) => {
  cardd = await startBoardServer(context, BOARD);
  main = await cardd.connect(cardd.addLane("main"));
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  page = await openBoardPage(context, browser, { width: 900, height: 900 });
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
const thread = (): Locator => page.getByRole("list", { name: "Thread" });

async function scout(mate: Session, title: string): Promise<Card> {
  return check(CardSchema, await mate.call("card.new", { title, kind: "scout" }));
}

const WHY = "The cancelled run changed nothing and the apply moved to the superseding card.";

test("a retired obsolete hold leaves Needs you at once and its audit trail shows on the card", async () => {
  const stale = await scout(cleo, "Review the apply of PR 417");
  await cleo.call("hold", {
    card: stale.id,
    question: "Approve the risky apply?",
    options: ["Yes"],
  });
  await main.call("hold", {
    card: stale.id,
    to: "captain",
    question: "Cleo asks to approve the risky apply of PR 417.",
    options: ["Yes", "No"],
  });
  assert.deepEqual(
    (await cardd.board()).holds.map((hold) => hold.card),
    [stale.id],
  );
  const superseding = await scout(cleo, "Apply with PR 420");

  await main.call("release", {
    card: stale.id,
    retire: { reason: WHY, supersededBy: superseding.id },
  });
  assert.deepEqual((await cardd.board()).holds, []);

  await page.goto(`${http()}#/c-${String(stale.id)}`);
  await thread().waitFor({ state: "attached" });
  const history = page.getByRole("button", { name: /^Show technical history/ });
  if (await history.count()) await history.click();
  const row = thread().locator("li", { hasText: "retired it as obsolete" });
  await row.waitFor();
  await row.getByRole("button").click();
  await row.locator(".event-more").waitFor();
  if (SHOTS !== undefined) {
    mkdirSync(SHOTS, { recursive: true });
    await thread().screenshot({ path: join(SHOTS, "retired-hold.png") });
  }
  const text = await row.innerText();
  assert.match(text, /Retired as obsolete, not approved or decided\./);
  assert.ok(text.includes(WHY));
  assert.ok(text.includes(`Superseded by #${String(superseding.id)}.`));
  assert.equal(await thread().getByText("decided", { exact: true }).count(), 0);
  assert.equal(await thread().getByText("answered", { exact: true }).count(), 0);
  await page.goto(`${http()}#/`);
  assert.equal(
    await page.getByText("Needs you").locator("..").getByText("Review the apply of PR 417").count(),
    0,
  );
});
