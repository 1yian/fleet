/// <reference lib="dom" />
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CardSchema, check, type Card } from "@fleet/protocol";
import type { Cardd, Session } from "../support/cardd.ts";
import { oldDatedHold } from "../support/fleet.ts";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const HOUR = 3_600_000;

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
  main = await cardd.connect(cardd.addLane("main"));
  page = await openBoardPage(context, browser);
});

const captainCard = async (title: string): Promise<Card> =>
  check(CardSchema, await main.call("card.new", { title, kind: "captain" }));

test("a dated wait shows what it waits on and how old it is, and an idle park says nothing is running", async () => {
  const quota = await captainCard("Wait for the weekly quota");
  await main.call("hold", {
    card: quota.id,
    question: "Quota resets?",
    until: Date.now() + 6 * HOUR,
    outside: "the weekly quota resets",
    remaining: [],
  });
  const forgotten = await captainCard("Renew the certificate");
  oldDatedHold(cardd, forgotten, "captain", Date.now() - 6 * 24 * HOUR, Date.now() + 6 * HOUR);
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));

  const waiting = page.getByRole("article", { name: "Wait for the weekly quota" });
  await waiting
    .locator("p.wait", {
      hasText: "waits on an outside date: the weekly quota resets · held just now",
    })
    .waitFor();
  assert.equal(await waiting.locator("p.wait.idle").count(), 0);

  const parked = page.getByRole("article", { name: "Renew the certificate" });
  await parked
    .locator("p.wait.idle", { hasText: "idle park, nothing running · held 6d" })
    .waitFor();

  await parked.getByRole("link", { name: "Renew the certificate" }).click();
  const detail = page.getByRole("list", { name: "Properties" }).or(page.getByLabel("Properties"));
  await detail.getByText("idle park, nothing running · held 6d").waitFor();
});
