import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chromium, type Browser as Client, type Page } from "playwright";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { WORKER_HOST } from "../support/fleet.ts";
import { embedLogin, type Login } from "../support/login-embedding.ts";
import { until } from "../support/login-fixtures.ts";
import { StaleLink, type Vintage } from "../support/stale-link.ts";
import { pointInPicture, startViewer, stopViewers, type Viewers } from "../support/viewer.ts";

const ENTERED = /a password entered through the viewer is still in this page's form/;
const TYPED = "S3cr3t-typed-in-a-stale-viewer";
const PASSWORD_FIELD = { x: 170, y: 86 };
const REVEAL = { x: 365, y: 86 };
const PASSWORD_VALUE = 'document.querySelector("input[name=p]").value';

let lab: BrowserLab;
let client: Client | undefined;
const viewers: Viewers = [];
const links: StaleLink[] = [];
let worker: RawWorker;
let login: Login;
let size: { width: number; height: number };

afterEach(async () => {
  const stopped = await Promise.allSettled([
    ...stopViewers(viewers),
    client?.close(),
    ...links.splice(0).map((link) => link.stop()),
    lab.stop(),
  ]);
  client = undefined;
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function begin(isolated = false): Promise<void> {
  lab = await BrowserLab.start({ isolated });
  worker = await lab.worker("Users sign in");
  await worker.act({ action: "open", url: lab.site.url("/entry") });
  login = await embedLogin(lab, worker, "document");
  const found: unknown = JSON.parse(
    await worker.act({ action: "eval", expression: "[innerWidth, innerHeight]" }),
  );
  if (!Array.isArray(found)) throw new Error("the page size is not a pair");
  size = { width: Number(found[0]), height: Number(found[1]) };
  client = await chromium.launch();
}

async function viewerPage(flags: string[], vintage: Vintage | undefined): Promise<Page> {
  const link = vintage === undefined ? undefined : await StaleLink.start(lab.cardd.url, vintage);
  if (link !== undefined) links.push(link);
  const { url } = await startViewer(
    lab,
    viewers,
    flags,
    {},
    link === undefined ? undefined : { token: lab.mainToken, host: WORKER_HOST, url: link.url },
  );
  const page = await client?.newPage({ viewport: { width: 1400, height: 900 } });
  assert.ok(page !== undefined);
  await page.goto(url);
  await until(
    async () => ((await page.locator("#live").textContent()) === "live" ? true : undefined),
    "the picture to be live",
  );
  return page;
}

const inChrome = (expression: string): Promise<unknown> => login.inChrome(expression);

const passwordIs = (wanted: string): Promise<true> =>
  until(
    async () => ((await inChrome(PASSWORD_VALUE)) === wanted ? true : undefined),
    `the password field to hold ${wanted}`,
  );

async function click(page: Page, at: { x: number; y: number }): Promise<void> {
  const point = await pointInPicture(page, size, at.x, at.y);
  await page.mouse.click(point.x, point.y);
}

async function typePassword(page: Page): Promise<void> {
  await click(page, PASSWORD_FIELD);
  await page.keyboard.type(TYPED);
  await passwordIs(TYPED);
}

async function revealPassword(page: Page): Promise<void> {
  await click(page, REVEAL);
  await until(
    async () =>
      (await inChrome('document.querySelector("input[name=p]").type')) === "text"
        ? true
        : undefined,
    "the empty password to be revealed before typing",
  );
}

const VINTAGES: readonly [Vintage, string][] = [
  ["no-build", "sends no build id"],
  ["old-build", "sends the id of an old build"],
];

for (const [vintage, sends] of VINTAGES) {
  for (const flags of [["--captain"], []]) {
    const mode = flags.length === 0 ? "gated" : "captain's";
    test(`a ${mode} viewer that ${sends} and declares nothing cannot put a password past the worker's eval, screenshots and HTML`, async () => {
      await begin();
      const page = await viewerPage(flags, vintage);
      assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '""');
      assert.ok((await worker.shoot()).length > 0);

      await typePassword(page);
      await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);
      await assert.rejects(worker.shoot(), ENTERED);
      await assert.rejects(worker.shoot(true), ENTERED);
      await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
      assert.match(await worker.act({ action: "read" }), /entry page/);

      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await passwordIs("");
      assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '""');
      assert.ok((await worker.shoot()).length > 0);
    });
  }
}

for (const embedding of ["closed-shadow", "cross-frame"] as const) {
  for (const flags of [["--captain"], []]) {
    const mode = flags.length === 0 ? "gated" : "captain's";
    test(`a ${mode} viewer that sends no build id cannot put a password past the worker when the login appears in a ${embedding} after the tab was listed and is revealed before typing`, async () => {
      await begin(embedding === "cross-frame");
      const page = await viewerPage(flags, "no-build");
      login = await embedLogin(lab, worker, embedding);
      await revealPassword(page);
      await typePassword(page);
      await assert.rejects(
        worker.act({ action: "eval", expression: "location.pathname" }),
        ENTERED,
      );
      await assert.rejects(worker.shoot(), ENTERED);
      await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);

      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await passwordIs("");
      assert.equal(
        await worker.act({ action: "eval", expression: "location.pathname" }),
        '"/entry"',
      );
      assert.ok((await worker.shoot()).length > 0);
    });
  }
}

test("a captain's stale viewer that keeps its tab through a cardd restart cannot put a password past the worker before it lists again", async () => {
  await begin();
  const page = await viewerPage(["--captain"], "no-build");
  const release = links[0]?.holdListings();
  assert.ok(release !== undefined);
  const before = worker;
  await lab.cardd.restart();
  worker = await lab.reconnect(before);
  await worker.act({ action: "open", url: lab.site.url("/a") });
  await worker.act({ action: "open", url: lab.site.url("/entry") });
  login = await embedLogin(lab, worker, "closed-shadow");
  await revealPassword(page);
  await typePassword(page);
  await assert.rejects(worker.act({ action: "eval", expression: "location.pathname" }), ENTERED);
  await assert.rejects(worker.shoot(), ENTERED);
  await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
  release();
});

test("a password that the worker typed itself stays readable beside a current viewer and is refused once a stale viewer lists the tab", async () => {
  await begin();
  await worker.act({ action: "type", selector: "input[name=p]", text: "worker-typed" });
  await viewerPage(["--captain"], undefined);
  assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '"worker-typed"');
  assert.ok((await worker.shoot()).length > 0);

  await viewerPage(["--captain"], "no-build");
  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);
  await assert.rejects(worker.shoot(), ENTERED);
  await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
});
