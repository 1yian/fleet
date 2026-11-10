import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BROWSER_OPS, check } from "@fleet/protocol";
import { chromium, type Browser as Client, type Page } from "playwright";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { optionalNumber, parseRecord } from "../support/json.ts";
import {
  pointInPicture,
  startViewer,
  stopViewers,
  waitFor,
  type Viewers,
} from "../support/viewer.ts";

const PROMPT_MS = 10_000;
const CARDS = 3;

let lab: BrowserLab;
let workers: RawWorker[];
let client: Client | undefined;
const viewers: Viewers = [];

beforeEach(async () => {
  lab = await BrowserLab.start({ stock: true });
  workers = [];
  for (let index = 0; index < CARDS; index += 1) {
    const worker = await lab.worker(`Check window ${String(index + 1)}`);
    await worker.act({ action: "open", url: lab.site.url("/a") });
    workers.push(worker);
  }
});
afterEach(async () => {
  const stopped = await Promise.allSettled([...stopViewers(viewers), client?.close(), lab.stop()]);
  client = undefined;
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function targets(): Promise<Map<number, string>> {
  const view = check(BROWSER_OPS["browser.view"].result, await lab.main.call("browser.view", {}));
  return new Map(view.tabs.map((tab) => [tab.card, tab.target]));
}

async function targetOf(worker: RawWorker): Promise<string> {
  const found = (await targets()).get(worker.card.id);
  assert.ok(found !== undefined, `c-${String(worker.card.id)} has no tab`);
  return found;
}

async function shotMs(worker: RawWorker): Promise<number> {
  const began = Date.now();
  const taken = worker.session.call("browser", { action: "screenshot" }).then((raw) => {
    check(BROWSER_OPS.browser.result, raw);
    return Date.now() - began;
  });
  const late = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `the screenshot of c-${String(worker.card.id)} was still waiting after ${String(PROMPT_MS)} ms`,
        ),
      );
    }, PROMPT_MS).unref();
  });
  return Promise.race([taken, late]);
}

test("a screenshot of a card that is not in front returns at once, and every card has a window of its own", async (t) => {
  const first = workers[0];
  const second = workers[1];
  assert.ok(first !== undefined && second !== undefined);
  const timings: number[] = [];
  for (let round = 0; round < 4; round += 1) {
    timings.push(await shotMs(first), await shotMs(second));
  }
  t.diagnostic(`screenshots of c-1 and c-2 behind c-${String(CARDS)}, in ms: ${timings.join(" ")}`);

  const windows = new Set<number>();
  for (const worker of workers) windows.add((await lab.chrome.window(await targetOf(worker))).id);
  assert.equal(windows.size, CARDS);
});

test("a summon raises the window of the card that asked, and no other", async () => {
  const targetsOfCards = await Promise.all(workers.map(targetOf));
  for (const target of targetsOfCards) await lab.chrome.minimize(target);
  for (const target of targetsOfCards)
    assert.equal((await lab.chrome.window(target)).state, "minimized");

  const asker = workers[1];
  const asked = targetsOfCards[1];
  assert.ok(asker !== undefined && asked !== undefined);
  await asker.session.call("browser", { action: "read", captain: "enter the code" });
  await waitFor(
    async () => (await lab.chrome.window(asked)).state === "normal",
    "the asking card's window to be raised",
  );
  const states = await Promise.all(
    targetsOfCards.map(async (id) => (await lab.chrome.window(id)).state),
  );
  assert.deepEqual(states, ["minimized", "normal", "minimized"]);
});

test("the captain's viewer shows and drives the card that it picks, in its own window", async (t) => {
  const url = (await startViewer(lab, viewers, ["--captain"])).url;
  client = await chromium.launch();
  const page: Page = await client.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(url);
  await waitFor(async () => (await page.locator("#tabs li").count()) === CARDS, "all tabs listed");

  const counts = async (): Promise<string[]> =>
    Promise.all(workers.map((worker) => worker.act({ action: "read", selector: "#n" })));
  assert.deepEqual(await counts(), ["0", "0", "0"]);

  const label = `c-${String(workers[1]?.card.id)} `;
  await page.locator("#tabs li", { hasText: label }).click();
  await waitFor(
    async () => (await page.locator("#live").textContent()) === "live",
    "the picture of the picked card",
  );
  const picked = workers[1];
  assert.ok(picked !== undefined);
  const size = parseRecord(
    await picked.act({
      action: "eval",
      expression: "({ width: innerWidth, height: innerHeight })",
    }),
  );
  const at = await pointInPicture(
    page,
    { width: optionalNumber(size, "width") ?? 1, height: optionalNumber(size, "height") ?? 1 },
    120,
    100,
  );
  await page.mouse.click(at.x, at.y);
  await waitFor(async () => (await counts()).join("") === "010", "the click to count in c-2 only");

  const timings: number[] = [];
  for (const worker of [workers[0], workers[2]]) {
    assert.ok(worker !== undefined);
    timings.push(await shotMs(worker));
  }
  t.diagnostic(
    `screenshots of the cards that the viewer is not showing, in ms: ${timings.join(" ")}`,
  );
});
