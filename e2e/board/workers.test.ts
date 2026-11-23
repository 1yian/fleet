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
import { boundBoardFile, openBoardPage, within } from "../support/board.ts";
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

test("a board read begun before cardd went away cannot bring its workers back", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  let mode: "pass" | "hold" | "hang" = "pass";
  let captured = (): void => undefined;
  const heldRead = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  context.after(finish);
  await page.route("**/api/board", async (route) => {
    if (mode === "pass") {
      await route.continue();
      return;
    }
    if (mode === "hang") {
      await ended;
      await route.abort().catch(() => undefined);
      return;
    }
    mode = "hang";
    const stale = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response: stale }).catch(() => undefined);
  });
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));
  const task = await newCard(main, "Archive the old campaign pages");
  await cardd.connect(await begin(main, task), [], true, true);
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor();

  mode = "hold";
  await newCard(main, "Plan the next quarter");
  await within(heldRead, 5000, "a board read starting while cardd was still up");
  await cardd.stop();
  const unavailable = page.getByText("Worker status is unavailable until cardd reconnects.");
  await unavailable.waitFor({ timeout: 10_000 });
  release();
  await delay(750);
  assert.equal(await unavailable.count(), 1);
  assert.equal(await page.getByRole("link", { name: task.title }).count(), 0);
});

test("worker rows cached before Analytics hid the board are not shown as live after cardd went away", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  let stall = false;
  let finish = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  context.after(finish);
  await page.route("**/api/board", async (route) => {
    if (!stall) {
      await route.continue();
      return;
    }
    await ended;
    await route.abort().catch(() => undefined);
  });
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));
  const task = await newCard(main, "Refresh the help center articles");
  await cardd.connect(await begin(main, task), [], true, true);
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor();

  const nav = page.getByRole("navigation", { name: "Fleet views" });
  await nav.getByRole("link", { name: "Analytics" }).click();
  await page.waitForFunction(() => location.hash === "#/analytics");
  await cardd.stop();
  stall = true;
  await nav.getByRole("link", { name: "Active Workers" }).click();
  await page
    .getByText("Worker status is unavailable until cardd reconnects.")
    .waitFor({ timeout: 5000 });
  assert.equal(await page.getByRole("link", { name: task.title }).count(), 0);
});

test("a board read held across an Analytics visit is dropped, not replayed, and the return reads at once", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  let holding = false;
  let reads = 0;
  let frames = 0;
  let captured = (): void => undefined;
  const heldRead = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  context.after(release);
  page.on("websocket", (socket) => {
    socket.on("framereceived", () => {
      frames += 1;
    });
  });
  await page.route("**/api/board", async (route) => {
    reads += 1;
    if (!holding) {
      await route.continue();
      return;
    }
    holding = false;
    const stale = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response: stale }).catch(() => undefined);
  });
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/#/workers"));
  const task = await newCard(main, "Rewrite the shipping policy page");
  await cardd.connect(await begin(main, task), [], true, true);
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor();

  holding = true;
  await newCard(main, "Plan the holiday campaign");
  await within(heldRead, 5000, "a board read starting before Analytics opened");
  const seen = frames;
  await newCard(main, "Review the partner contract");
  for (let waited = 0; frames === seen; waited += 20) {
    assert.ok(waited < 5000, "the second change never reached the browser as a live notification");
    await delay(20);
  }
  const nav = page.getByRole("navigation", { name: "Fleet views" });
  await nav.getByRole("link", { name: "Analytics" }).click();
  await page.waitForFunction(() => location.hash === "#/analytics");
  const hidden = reads;
  await delay(750);
  assert.equal(reads, hidden, "no board read starts while Analytics is showing");

  await nav.getByRole("link", { name: "Active Workers" }).click();
  await row(page, "Working", task).getByText("Running", { exact: true }).waitFor({ timeout: 3000 });
  assert.ok(reads > hidden, "returning to the board starts a fresh read");
});

test("Active Workers keeps the scroll position it was left at across links and browser history", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const page = await openBoardPage(context, browser);
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
  let last: Card | undefined;
  for (let n = 1; n <= 14; n++) {
    last = await newCard(main, `Prepare the release note ${String(n)}`);
    await cardd.connect(await begin(main, last), [], true, true);
  }
  assert.ok(last !== undefined);
  await page
    .getByRole("navigation", { name: "Fleet views" })
    .getByRole("link", { name: "Active Workers" })
    .click();
  await row(page, "Working", last).getByText("Running", { exact: true }).waitFor();
  const heading = page.getByRole("heading", { name: "Active Workers" });
  const scrolled = (y: number) =>
    page.waitForFunction((to) => Math.abs(window.scrollY - to) <= 1, y, { timeout: 5000 });

  await page.evaluate(() => {
    window.scrollTo(0, 240);
    history.back();
  });
  await heading.waitFor({ state: "detached" });
  await page.goForward();
  await heading.waitFor();
  await scrolled(240);

  await page.evaluate(() => {
    window.scrollTo(0, 120);
    document.querySelector<HTMLAnchorElement>('a[href="#/"]')?.click();
  });
  await heading.waitFor({ state: "detached" });
  await page.goBack();
  await heading.waitFor();
  await scrolled(120);
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

interface Stalling {
  readonly url: string;
  readonly delivered: Promise<void>;
  readonly abandoned: Promise<number>;
  readonly close: () => void;
}

async function stallingServer(): Promise<Stalling> {
  const sockets = new Set<Socket>();
  let delivered = (): void => undefined;
  let abandoned = (_elapsed: number): void => undefined;
  const server = createServer((_request, response) => {
    const started = Date.now();
    response.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    response.write('{"cards":[', () => {
      delivered();
    });
    response.on("close", () => {
      if (!response.writableEnded) abandoned(Date.now() - started);
    });
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
    delivered: new Promise<void>((resolve) => {
      delivered = resolve;
    }),
    abandoned: new Promise<number>((resolve) => {
      abandoned = resolve;
    }),
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test("a board response that stalls after a partial body is abandoned at the deadline and the next change is shown", async (context) => {
  const { cardd, main } = await startFleet({}, ["--board", BOARD]);
  context.after(() => cardd.stop());
  const stalled = await stallingServer();
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
  await within(stalled.delivered, 10_000, "the first board read reaching the stall server");

  const task = await newCard(main, "Refresh the partner logos");
  await cardd.connect(await begin(main, task), [], true, true);
  await row(page, "Working", task)
    .getByText("Running", { exact: true })
    .waitFor({ timeout: 20_000 });
  const elapsed = await within(
    stalled.abandoned,
    15_000,
    "the browser abandoning the stalled read",
  );
  assert.ok(elapsed >= 9000, `the browser dropped the stalled body after ${String(elapsed)} ms`);
});
