/// <reference lib="dom" />
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import { tempDir } from "../support/run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];

boundBoardFile();

async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function assertTaskQueues(page: Page): Promise<void> {
  const project = page.getByRole("region", { name: "No project", exact: true });
  await project.getByRole("article").first().waitFor();
  await page
    .getByRole("region", { name: "Schedules", exact: true })
    .getByText("Review today's spending", { exact: true })
    .waitFor();
  await shoot(page, "scheduler-queues");
  assert.equal(await project.getByRole("article").count(), 2);
  assert.equal(await project.locator(".lane-head .n").innerText(), "2 open");
  assert.equal(
    await project
      .getByRole("region", { name: "Up next", exact: true })
      .locator(".cell-head .n")
      .innerText(),
    "2",
  );
  assert.equal(await page.locator(".col-head.up-next .n").innerText(), "2");
}

test("scheduled deliveries keep their history without becoming tasks or inflating queue counts", async (context) => {
  const root = tempDir("board-schedules-");
  mkdirSync(root, { recursive: true });
  const clock = join(root, "clock");
  const setClock = (iso: string): void => {
    const next = `${clock}.${randomUUID()}.tmp`;
    writeFileSync(next, iso);
    renameSync(next, clock);
  };
  setClock("2026-05-04T04:59:00Z");
  const cardd = await startBoardServer(context, BOARD, {
    CARDD_TIMING_SCALE: "0.01",
    CARDD_CLOCK_FILE: clock,
  });
  const main = await cardd.connect(cardd.addLane("main"));
  context.after(() => main.close());
  const captain = check(
    CardSchema,
    await main.call("card.new", {
      title: "Scheduled messages",
      name: "scheduled-messages",
      kind: "captain",
    }),
  );
  const standing = check(
    CardSchema,
    await main.call("card.new", {
      title: "Scheduled messages",
      name: "review-reminders",
      kind: "standing",
    }),
  );
  const schedule = check(
    OPS["schedule.set"].result,
    await main.call("schedule.set", {
      to: "main",
      at: "05:00",
      timezone: "UTC",
      text: "Review today's spending",
    }),
  );
  setClock("2026-05-04T05:00:00Z");
  const first = await main.waitForEntry(
    (entry) => entry.author === "schedule" && entry.fields["schedule"] === schedule.id,
    "the scheduled delivery",
  );
  assert.equal(first.body, "Review today's spending");
  const log = (await cardd.thread(first.card)).card;
  assert.equal(log.kind, "standing");
  assert.equal(log.name, "scheduled-messages");
  assert.notEqual(log.id, captain.id);

  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await openBoardPage(context, browser, { width: 1440, height: 900 });
  const url = cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
  await page.goto(url);
  await assertTaskQueues(page);
  const tasks = check(OPS.board.result, await main.call("board", {}));
  assert.deepEqual(tasks.map(({ id }) => id).sort(), [captain.id, standing.id].sort());
  assert.deepEqual((await cardd.board()).schedules, [schedule]);

  await page.goto(`${url}#/c-${String(log.id)}`);
  await page.getByRole("heading", { name: "Scheduled messages", exact: true }).waitFor();
  await page.getByText("Review today's spending", { exact: true }).waitFor();
  await shoot(page, "scheduler-history");
  setClock("2026-05-05T05:00:00Z");
  const second = await main.waitForEntry(
    (entry) =>
      entry.author === "schedule" &&
      entry.fields["schedule"] === schedule.id &&
      entry.id !== first.id,
    "the next daily delivery",
  );
  assert.equal(second.card, log.id);
  assert.equal(second.body, "Review today's spending");
  const history = await cardd.thread(log.id);
  assert.deepEqual(
    history.entries.filter((entry) => entry.author === "schedule").map((entry) => entry.id),
    [first.id, second.id],
  );
  assert.equal(history.card.status, "waiting");
  assert.deepEqual(check(OPS["schedule.list"].result, await main.call("schedule.list", {})), [
    schedule,
  ]);
});

test("a second mate's standing task can use the scheduler log name without being hidden", async (context) => {
  const cardd = await startBoardServer(context, BOARD);
  const main = await cardd.connect(cardd.addLane("main"));
  const ads = await cardd.connect(cardd.addLane("ads", "main"));
  context.after(() => Promise.all([main.close(), ads.close()]));
  const task = check(
    CardSchema,
    await ads.call("card.new", {
      title: "Review scheduled messages",
      name: "scheduled-messages",
      kind: "standing",
    }),
  );
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await openBoardPage(context, browser);
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
  const project = page.getByRole("region", { name: "No project", exact: true });
  await project.getByRole("article", { name: task.title }).waitFor();
  assert.equal(await project.locator(".lane-head .n").innerText(), "1 open");
  const tasks = check(OPS.board.result, await ads.call("board", {}));
  assert.equal(tasks.find((card) => card.id === task.id)?.title, task.title);
});
