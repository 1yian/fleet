import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Card } from "@fleet/protocol";
import { boundBoardFile, openBoardPage } from "../support/board.ts";
import { begin, newCard, startFleet } from "../support/fleet.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SHOTS = process.env["FLEET_E2E_SHOTS"];

boundBoardFile();

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

async function shoot(page: Page): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(SHOTS, `active-workers-${String(width)}.png`) });
  }
}

function row(page: Page, group: string, card: Card) {
  return page
    .getByRole("region", { name: group, exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: card.title, exact: true }) });
}

test("active workers move between working, waiting, and disconnected without reloading the board", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const page = await openBoardPage(context, browser);
  const address = cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

  await page.goto(address);
  const nav = page.getByRole("navigation", { name: "Fleet views" });
  const workers = nav.getByRole("link", { name: "Active Workers" });
  await workers.click();
  await page.getByRole("heading", { name: "Active Workers" }).waitFor();
  await page.getByText("No workers are working now.").waitFor();

  const building = await newCard(main, "Make search results easier to scan");
  const checking = await newCard(cleo, "Validate the landing page");
  const held = await newCard(cleo, "Compare the new signup flows");
  const gone = await newCard(main, "Investigate delayed notifications");
  const queued = await newCard(main, "Draft the help center outline");
  const builder = await cardd.connect(await begin(main, building), [], true, true);
  const reviewer = await cardd.connect(await begin(cleo, checking), [], true, true);
  await reviewer.call("report", {
    status: "in-review",
    text: "The validation pipeline is running.",
  });
  await cardd.connect(await begin(cleo, held));
  await cleo.call("hold", { card: held.id, question: "Which flow should we ship?" });
  const lostToken = await begin(main, gone);
  const lost = await cardd.connect(lostToken, [], true, true);
  await lost.close();

  const working = row(page, "Working", building);
  await working.getByText("Running", { exact: true }).waitFor();
  assert.match(await working.innerText(), new RegExp(`#${String(building.id)} · main`));
  const waiting = row(page, "Waiting", checking);
  await waiting.getByText("In review", { exact: true }).waitFor();
  assert.match(await waiting.innerText(), new RegExp(`#${String(checking.id)} · cleo`));
  await row(page, "Waiting", held).getByText("With main", { exact: true }).waitFor();
  await row(page, "Disconnected or stale", gone)
    .getByText("Disconnected", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("link", { name: queued.title }).count(), 0);
  await shoot(page);

  await working.getByRole("link", { name: building.title }).click();
  await page.getByRole("heading", { name: building.title }).waitFor();
  await page.getByRole("button", { name: "Fleet" }).click();
  await working.getByRole("link", { name: building.title }).waitFor();
  assert.equal(await workers.getAttribute("aria-current"), "page");

  await builder.call("report", { status: "blocked", text: "Need my mate to decide." });
  await row(page, "Waiting", building).getByText("With main", { exact: true }).waitFor();
  await working.waitFor({ state: "detached" });

  await cardd.connect(lostToken, [], true, true);
  await row(page, "Working", gone).getByText("Running", { exact: true }).waitFor();
  await row(page, "Disconnected or stale", gone).waitFor({ state: "detached" });
});

test("a connected worker with stale running activity is never shown as working", async (context) => {
  const { cardd, main } = await startFleet({ CARDD_TIMING_SCALE: "0.04" }, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));
  await page.getByText("No workers are working now.").waitFor();

  const task = await newCard(main, "Check the release checklist");
  const worker = await cardd.connect(await begin(main, task), [], true, true);
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor();
  await row(page, "Disconnected or stale", task).getByText("Stale activity").waitFor();
  await page.getByText("No workers are working now.").waitFor();

  worker.send({ t: "activity", state: "running" });
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor({ timeout: 5000 });
  await row(page, "Disconnected or stale", task).waitFor({ state: "detached", timeout: 5000 });
});

test("a worker whose merge is authorized is waiting until it runs, then working", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));
  await page.getByText("No workers are working now.").waitFor();

  const task = await newCard(main, "Ship the pricing page copy");
  const worker = await cardd.connect(await begin(main, task), [], true, true);
  const url = "https://github.com/acme/web/pull/7";
  cardd.gh.setPr(url, "OPEN");
  await worker.call("report", { status: "done", text: "PR green and ready", pr: url });
  worker.send({ t: "activity", state: "idle" });
  await row(page, "Waiting", task).waitFor();

  await main.call("release", {
    card: task.id,
    words: "yes, merge it",
    source: "chat",
    choice: "Approve & merge",
  });
  await page.getByText("No workers are working now.").waitFor();
  await row(page, "Waiting", task).getByText("Merge approved", { exact: true }).waitFor();

  worker.send({ t: "activity", state: "running" });
  await row(page, "Working", task).getByText("Merging", { exact: true }).waitFor();
  await row(page, "Waiting", task).waitFor({ state: "detached" });
});

test("cached working rows are hidden promptly when cardd goes away", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));
  const task = await newCard(main, "Tidy the onboarding emails");
  await cardd.connect(await begin(main, task), [], true, true);
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor();

  await cardd.stop();
  await page
    .getByText("Worker status is unavailable until cardd reconnects.")
    .waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole("link", { name: task.title }).count(), 0);
});

test("a card opened from Active Workers returns there after back and forward history", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
  const task = await newCard(main, "Review the invoice template");
  await cardd.connect(await begin(main, task), [], true, true);
  await page
    .getByRole("navigation", { name: "Fleet views" })
    .getByRole("link", { name: "Active Workers" })
    .click();
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor();
  await row(page, "Working", task).getByRole("link", { name: task.title }).click();
  await page.getByRole("heading", { name: task.title }).waitFor();

  await page.goBack();
  await page.goBack();
  await page.getByRole("heading", { name: "Active Workers" }).waitFor({ state: "detached" });
  await page.goForward();
  await page.goForward();
  await page.getByRole("heading", { name: task.title }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Active Workers" }).waitFor();
  await row(page, "Working", task).waitFor();
});

test("a slow board read still publishes while live changes keep arriving", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  await page.route("**/api/board", async (route) => {
    await delay(1500);
    await route.continue();
  });
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));
  await page.getByText("No workers are working now.").waitFor();

  const noisy = await newCard(main, "Keep the changelog current");
  const added = await newCard(main, "Translate the pricing page");
  const chatter = await cardd.connect(await begin(main, noisy), [], true, true);
  const churn = setInterval(() => {
    chatter.send({ t: "activity", state: "idle" });
    chatter.send({ t: "activity", state: "running" });
  }, 300);
  context.after(() => {
    clearInterval(churn);
  });
  await cardd.connect(await begin(main, added), [], true, true);
  await row(page, "Working", added)
    .getByText("Running", { exact: true })
    .waitFor({ timeout: 10_000 });
});

async function stallingServer(sendBody: boolean): Promise<{ url: string; close: () => void }> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    if (sendBody) response.write('{"cards":[');
    else response.flushHeaders();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback port");
  return {
    url: `http://127.0.0.1:${String(address.port)}/api/board`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

for (const [phase, sendBody] of [
  ["headers", false],
  ["a partial body", true],
] as const) {
  test(`a board response that stalls after ${phase} is abandoned and the next change is shown`, async (context) => {
    const { cardd, main } = await startFleet({}, ["--board", BOARD]);
    context.after(() => cardd.stop());
    const stalled = await stallingServer(sendBody);
    context.after(() => {
      stalled.close();
    });
    const page = await openBoardPage(context, browser);
    let reads = 0;
    await page.route("**/api/board", async (route) => {
      reads += 1;
      if (reads === 1) await route.continue({ url: stalled.url });
      else await route.continue();
    });
    await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));

    const task = await newCard(main, "Refresh the partner logos");
    await cardd.connect(await begin(main, task), [], true, true);
    await row(page, "Working", task)
      .getByText("Running", { exact: true })
      .waitFor({ timeout: 20_000 });
  });
}
