/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import { ageCard, begin, newCard } from "../support/fleet.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];
boundBoardFile();

test("original board shows decisions inline without an Attention duplicate or neglect metadata", async (context) => {
  const browser = await chromium.launch();
  const cardd = await startBoardServer(context, BOARD);
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  const main = await cardd.connect(cardd.addLane("main"));
  const failed = await newCard(main, "Fix the release");
  const worker = await cardd.connect(await begin(main, failed));
  try {
    await worker.call("report", { status: "failed", text: "The build is red" });
    const idle = await newCard(main, "Unattended invoices");
    ageCard(cardd, idle, 25 * 3_600_000);
    const choice = await newCard(main, "Choose the release name");
    await main.call("hold", {
      card: choice.id,
      question: "Use the short name?",
      options: ["Short", "Long"],
    });
    for (const width of [1440, 390]) {
      const page = await openBoardPage(context, browser, { width, height: 900 });
      await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
      const card = page.getByRole("article", { name: "Choose the release name" });
      await card.getByRole("button", { name: "Short", exact: true }).waitFor();
      await page.getByRole("article", { name: "Fix the release" }).waitFor();
      assert.equal(await page.getByRole("region", { name: "Attention" }).count(), 0);
      assert.equal(await page.locator(".pulse-line").count(), 0);
      assert.equal(await page.getByRole("article", { name: "Unattended invoices" }).count(), 1);
      if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(
          join(SHOTS, `original-board-${String(width)}.txt`),
          await page.locator("body").innerText(),
        );
        await page.screenshot({
          path: join(SHOTS, `original-board-${String(width)}.png`),
          fullPage: true,
        });
      }
      if (width === 390) {
        await card.getByRole("button", { name: "Short", exact: true }).click();
        await card
          .getByRole("button", { name: "Short", exact: true })
          .waitFor({ state: "detached" });
        assert.equal(
          (await cardd.thread(choice.id)).entries.findLast((entry) => entry.kind === "answer")
            ?.body,
          "Short",
        );
      }
      await page.close();
    }
  } finally {
    await Promise.allSettled([main.close(), worker.close(), browser.close()]);
  }
});
