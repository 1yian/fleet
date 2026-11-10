import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chromium, type Browser as Client, type Page } from "playwright";
import { BrowserLab } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  ALL_VALUES,
  assertNoSecretAnywhere as scan,
  CREDENTIAL_SHOWN,
  FILLED,
  FIELD,
  GOOD,
  signedIn,
  until,
} from "../support/login-fixtures.ts";
import { startViewer, stopViewers, type Viewers } from "../support/viewer.ts";

let vault: FakeVault;
let lab: BrowserLab;
let client: Client | undefined;
const viewers: Viewers = [];
let page: Page;

beforeEach(() => {
  vault = new FakeVault([GOOD]);
});
afterEach(async () => {
  const stopped = await Promise.allSettled([...stopViewers(viewers), client?.close(), lab.stop()]);
  client = undefined;
  vault.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const at = (path: string): string => lab.site.url(path, "login.example.test");

const onPath = (label: string, path: string): Promise<void> =>
  until(async () => {
    const tab = (await lab.chrome.pages()).find((each) => each.title.startsWith(label));
    if (tab === undefined) return undefined;
    const where = await lab.chrome.evaluate(tab.id, "location.pathname").catch(() => undefined);
    return where === path ? true : undefined;
  }, `the tab to be on ${path}`).then(() => undefined);

test("a Back that the captain presses in the viewer leaves eval and screenshots refused while the restored form holds the login", async () => {
  lab = await BrowserLab.start({ vault });
  const worker = await signedIn(lab, "/portal");
  const label = `c-${String(worker.card.id)} `;
  const { url } = await startViewer(lab, viewers, ["--captain"]);
  client = await chromium.launch();
  page = await client.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(url);
  await until(
    async () => ((await page.locator("#live").textContent()) === "live" ? true : undefined),
    "the picture to be live",
  );

  await worker.act({ action: "click", selector: "#submit" });
  await onPath(label, "/landing");
  await until(
    async () =>
      (await page.getByRole("button", { name: "Back in this tab" }).isEnabled()) ? true : undefined,
    "Back to be offered",
  );
  await page.getByRole("button", { name: "Back in this tab" }).click();
  await onPath(label, "/portal");

  const reverse = `${FIELD("u")}.value.split("").reverse().join("")`;
  await assert.rejects(worker.act({ action: "eval", expression: reverse }), FILLED);
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

  await worker.act({ action: "open", url: at("/portal?again=1") });
  assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [
    "",
    "",
  ]);
  assert.ok((await worker.shoot()).length > 0);
  scan(lab, vault);
});

test("the worker's own back keeps the refusals, and a reload shows no stored value", async () => {
  lab = await BrowserLab.start({ vault });
  const worker = await signedIn(lab, "/portal");
  const label = `c-${String(worker.card.id)} `;

  await worker.act({ action: "click", selector: "#submit" });
  await onPath(label, "/landing");
  assert.equal(await worker.act({ action: "back" }), "Went back.");
  await onPath(label, "/portal");
  const reverse = `${FIELD("u")}.value.split("").reverse().join("")`;
  await assert.rejects(worker.act({ action: "eval", expression: reverse }), FILLED);
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

  assert.equal(await worker.act({ action: "reload" }), "Reloaded.");
  const reloaded = await worker
    .act({ action: "eval", expression: ALL_VALUES })
    .then((values): unknown => JSON.parse(values))
    .catch((error: unknown) => String(error));
  assert.ok(
    Array.isArray(reloaded)
      ? reloaded.every((value) => value === "")
      : FILLED.test(String(reloaded)),
    `a reload shows the stored values: ${JSON.stringify(reloaded)}`,
  );
  assert.equal(await worker.act({ action: "forward" }), "Went forward.");
  await onPath(label, "/landing");
  assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/landing"');
  scan(lab, vault);
});
