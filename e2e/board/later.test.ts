/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import { seedKanban } from "../support/kanban.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];
boundBoardFile();

test("Later restores the three original choices without a typed-date box and preserves captain deferral records", async (context) => {
  const browser = await chromium.launch();
  const cardd = await startBoardServer(context, BOARD);
  const main = await cardd.connect(cardd.addLane("main"));
  try {
    const fleet = await seedKanban(cardd, main);
    const page = await openBoardPage(context, browser, { width: 1440, height: 900 }, "Asia/Tokyo");
    await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
    const card = page.getByRole("article", { name: "Pick the API version" });
    await card.getByRole("button", { name: "Later", exact: true }).click();
    const later = card.getByRole("group", { name: "Ask me later" });
    assert.deepEqual(await later.getByRole("button").allTextContents(), [
      "In 3 hours",
      "Tomorrow 09:00",
      "Monday 09:00",
      "Cancel",
    ]);
    assert.equal(await later.getByRole("textbox").count(), 0);
    if (SHOTS !== undefined) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, "original-later-presets.png") });
    }
    const before = Date.now();
    await later.getByRole("button", { name: "In 3 hours" }).click();
    await page
      .getByRole("region", { name: "Up next", exact: true })
      .getByRole("article", { name: "Pick the API version" })
      .waitFor();
    assert.equal(await page.locator(".notice.held").count(), 0);
    const entries = (await cardd.thread(fleet.cards["simple"]?.id ?? 0)).entries;
    const hold = entries.findLast((entry) => entry.kind === "hold");
    assert.equal(hold?.author, "captain");
    assert.deepEqual(hold.fields["wait"], { by: "later", text: "in 3 hours" });
    const until = hold.fields["until"];
    assert.ok(
      typeof until === "number" &&
        until >= before + 3 * 3_600_000 &&
        until <= Date.now() + 3 * 3_600_000,
    );
  } finally {
    await Promise.allSettled([main.close(), browser.close()]);
  }
});
