import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Card } from "@fleet/protocol";
import { CardSchema, check } from "@fleet/protocol";
import type { Cardd, Session } from "../support/cardd.ts";
import { boundBoardFile, openBoardPage, startBoardServer, within } from "../support/board.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));

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

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

async function question(title: string, options: string[]): Promise<Card> {
  const card = check(CardSchema, await main.call("card.new", { title, kind: "captain" }));
  await main.call("hold", { card: card.id, question: `${title}?`, options });
  return card;
}

test("a board load that finishes late is followed by the queued newer one", async () => {
  let calls = 0;
  let finished = 0;
  let holding = false;
  let heldCalls = Number.POSITIVE_INFINITY;
  let captured = (): void => undefined;
  const heldRead = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let frames = 0;
  page.on("websocket", (socket) => {
    socket.on("framereceived", () => {
      frames += 1;
    });
  });
  page.on("requestfinished", (request) => {
    if (request.url().endsWith("/api/board")) finished += 1;
  });
  await page.route("**/api/board", async (route) => {
    calls += 1;
    if (!holding || calls > heldCalls) {
      await route.continue();
      return;
    }
    const stale = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response: stale });
  });
  await page.goto(http());
  await page.getByText("Nothing is on the board.").waitFor();
  for (let waited = 0; finished < 2; waited += 20) {
    assert.ok(waited < 5000, "the board never finished its startup and live-socket reads");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  heldCalls = calls + 1;
  holding = true;
  await question("Pick the API version", ["v1", "v2"]);
  await within(heldRead, 5000, "the first live change starting a board read");
  const seen = frames;
  await question("Renew the certificate", ["now", "later"]);
  for (let waited = 0; frames === seen; waited += 20) {
    assert.ok(waited < 5000, "the second change never reached the browser as a live notification");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    calls,
    heldCalls,
    "the live change queues behind the held read instead of starting another",
  );
  assert.equal(await page.getByText("Renew the certificate?").count(), 0);
  release();
  await page.getByText("Pick the API version?").waitFor();
  await page.getByText("Renew the certificate?").waitFor();
  assert.equal(calls, heldCalls + 1);
});
