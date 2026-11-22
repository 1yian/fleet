/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { CardSchema, check } from "@fleet/protocol";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import type { Session } from "../support/cardd.ts";
import { tempDir } from "../support/run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];
const NOW = "2026-05-04T12:30:00Z";

boundBoardFile();

function usage(
  id: string,
  date: string,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
) {
  return JSON.stringify({
    id,
    date: `2026-05-${date}:00Z`,
    role: "main",
    model: "fixture-model",
    usage: {
      input,
      cacheRead,
      cacheWrite,
      output,
      totalTokens: input + cacheRead + cacheWrite + output,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    },
  });
}

function ledger(root: string, lane: string, lines: readonly string[]): string {
  const home = join(root, lane);
  const profile = join(home, "ledger", "profiles", lane);
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(home, "config", "optchat.json"),
    JSON.stringify({ enabled: true, memoryHome: "ledger", profile: lane }),
  );
  writeFileSync(join(profile, "usage.jsonl"), lines.join("\n"));
  return home;
}

async function historicalCloses(path: string, main: Session): Promise<void> {
  const days = ["01", "02", "02", "04", "04", "04", "04", "04"];
  const cards = await Promise.all(
    days.map((_, i) =>
      main.call("card.new", { title: `Historical card ${i + 1}`, kind: "captain" }),
    ),
  );
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    const insert = db.prepare(
      "INSERT INTO entries (card, author, kind, fields, created_at) VALUES (?, 'mate:main', 'cleanup', ?, ?)",
    );
    for (const [i, row] of cards.entries()) {
      const card = check(CardSchema, row);
      insert.run(
        card.id,
        JSON.stringify({ outcome: i === 7 ? "dropped" : "done", archives: [], left: [] }),
        Date.parse(`2026-05-${days[i] ?? "01"}T09:00:00Z`),
      );
    }
  } finally {
    db.close();
  }
}

async function shoot(page: Page, file: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, file), fullPage: true });
}

function ledgers(root: string) {
  const repeated = usage("main-16", "03T16:30", 1_200, 28_000, 800, 2_000);
  return {
    mainHome: ledger(root, "main", [
      usage("expired", "03T12:29", 1_000_000, 0, 0, 0),
      usage("first", "03T12:45", 5_000, 11_000, 3_000, 1_500),
      usage("zero", "03T13:10", 0, 0, 0, 0),
      repeated,
      repeated,
      usage("main-18", "03T18:50", 6_000, 18_000, 2_000, 3_000),
      usage("main-01", "04T01:30", 14_000, 37_000, 1_000, 2_000),
      usage("main-07", "04T07:15", 3_000, 22_000, 3_000, 1_000),
      usage("main-10", "04T10:50", 17_000, 60_000, 2_000, 5_000),
      usage("main-12", "04T12:15", 4_000, 18_000, 500, 800),
      usage("future", "04T12:31", 1_000_000, 0, 0, 0),
      '{"date":"2026-05-03T14:10:00Z","usage":{"input":0}}',
      '{"date":',
    ]),
    secondHome: ledger(root, "cleo", [
      usage("cleo-16", "03T16:50", 400, 9_000, 600, 800),
      usage("cleo-21", "03T21:30", 2_000, 32_000, 1_000, 1_000),
      usage("cleo-08", "04T08:30", 5_000, 38_000, 1_000, 1_000),
    ]),
  };
}

test("analytics reconciles readable ledger usage and successful closes in the real board", async (context) => {
  const root = tempDir("board-analytics-");
  const clock = join(root, "clock");
  writeFileSync(clock, NOW);
  const { mainHome, secondHome } = ledgers(root);
  const cardd = await startBoardServer(context, BOARD, { CARDD_CLOCK_FILE: clock });
  const main = await cardd.connect(cardd.addLane("main", undefined, mainHome));
  context.after(() => main.close());
  cardd.addLane("cleo", "main", secondHome);
  cardd.addLane("unavailable", "main", join(root, "absent"));
  await historicalCloses(cardd.db, main);

  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await openBoardPage(
    context,
    browser,
    { width: 1440, height: 900 },
    "America/Los_Angeles",
  );
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
  await page.getByRole("link", { name: "Analytics" }).click();
  const hourly = page.getByRole("region", { name: "Tokens used by hour" });
  const inspector = hourly.locator("[aria-live=polite]");
  await hourly.getByText("363,600", { exact: true }).waitFor();
  assert.equal(await hourly.getByRole("button").count(), 25);
  await hourly
    .getByRole("button", { name: /^May 3, 12:30 to 13:00 UTC \(partial\): 20,500 tokens/ })
    .focus();
  assert.match(await inspector.innerText(), /20,500 tokens/);
  await hourly.getByRole("button", { name: /^May 3, 13:00.*: 0 tokens/ }).focus();
  assert.match(await inspector.innerText(), /0 tokens · Input: 0 · Cached input: 0 · Output: 0/);
  await hourly.getByRole("button", { name: /^May 3, 14:00.*: No usage records/ }).focus();
  assert.match(await inspector.innerText(), /No usage records/);
  await hourly.getByRole("button", { name: /^May 3, 16:00/ }).hover();
  assert.match(
    await inspector.innerText(),
    /42,800 tokens · Input: 3,000 · Cached input: 37,000 · Output: 2,800/,
  );

  const lanes = page.getByRole("region", { name: "Tokens by lane" });
  assert.deepEqual(await lanes.getByRole("listitem").allTextContents(), [
    "main271,800Input: 62,500 · Cached input: 194,000 · Output: 15,300",
    "cleo91,800Input: 10,000 · Cached input: 79,000 · Output: 2,800",
  ]);
  const closures = page.getByRole("region", { name: "Cards closed as done" });
  assert.deepEqual(await closures.getByRole("listitem").allTextContents(), [
    "0Apr 28",
    "0Apr 29",
    "0Apr 30",
    "1May 1",
    "2May 2",
    "0May 3",
    "4Today",
  ]);
  await shoot(page, "analytics-desktop.png");

  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page.locator("main.kanban").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goBack();
  await hourly.getByText("363,600", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await hourly
    .getByRole("button", { name: /^May 4, 12:00 to 12:30 UTC \(partial\): 23,300 tokens/ })
    .focus();
  await shoot(page, "analytics-mobile.png");
});
