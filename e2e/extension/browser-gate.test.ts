import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chromium, type Browser as Client } from "playwright";
import { BrowserHerdr, until, type Stream } from "../support/browser-herdr.ts";
import { FakeVault } from "../support/fake-vault.ts";
import { formsOf } from "../support/leaks.ts";
import { type JsonRecord } from "../support/json.ts";
import { GOOD, PASSWORD, USERNAME } from "../support/login-fixtures.ts";

let fleet: BrowserHerdr;
let vault: FakeVault | undefined;
let client: Client | undefined;
const streams: Stream[] = [];

afterEach(async (t) => {
  await Promise.allSettled(streams.splice(0).map((stream) => stream.stop()));
  await client?.close();
  client = undefined;
  await fleet.stop(t);
  vault?.dispose();
  vault = undefined;
});

const isFrame = (message: JsonRecord): boolean => typeof message["data"] === "string";
const isHidden = (message: JsonRecord): boolean => typeof message["hidden"] === "string";
const leaks = (text: string): boolean =>
  [PASSWORD, USERNAME].some((secret) => formsOf(secret).some((form) => text.includes(form)));

async function watch(address: string, target: string): Promise<Stream> {
  const stream = await fleet.streamOf(address, target);
  streams.push(stream);
  return stream;
}

async function tabId(): Promise<string> {
  const [only] = await fleet.chrome.pages();
  assert.ok(only !== undefined);
  return only.id;
}

test("a worker's own viewer shows no picture while a login-filled field holds the credential, and draws again once the page moves on", async () => {
  vault = new FakeVault([GOOD]);
  fleet = await BrowserHerdr.start({ browser: true, vault });
  const [worker] = await fleet.workers(["Sign in to the portal"]);
  assert.ok(worker !== undefined);
  const portal = fleet.site.url("/portal", "login.example.test");
  assert.equal((await fleet.axi(worker, `open '${portal}'`)).code, 0);
  const address = await fleet.viewerOf(worker.workspace);
  const target = await tabId();
  const watching = await watch(address, target);
  await until("a picture before the login", () => watching.messages.find(isFrame));

  const login = await fleet.axi(worker, "login");
  assert.equal(login.code, 0, login.text);
  await until("the viewer to hide the page", () =>
    watching.messages.some(isHidden) ? true : undefined,
  );
  const later = await watch(address, target);
  const first = await until("the first message of a new stream", () => later.messages[0]);
  assert.equal(isHidden(first), true);
  assert.equal(isFrame(first), false);

  client = await chromium.launch();
  const page = await client.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(address);
  await page.locator("#note").waitFor({ state: "visible" });
  assert.match(await page.locator("#note").innerText(), /^Hidden: .*stored credential/);
  assert.equal(await page.locator("#screen").isHidden(), true);
  assert.equal(leaks(await page.locator("body").innerText()), false);
  assert.equal(leaks((await fleet.listingOf(address)).body), false);

  const firstHidden = watching.messages.findIndex(isHidden);
  const hiddenSoFar = watching.messages.filter(isHidden).length;
  const typed = await fleet.axi(worker, "type --text x --selector 'input[name=u]'");
  assert.equal(typed.code, 0, typed.text);
  await until("the viewer to hide the changed page", () =>
    watching.messages.filter(isHidden).length > hiddenSoFar ? true : undefined,
  );
  assert.equal(watching.messages.slice(firstHidden).some(isFrame), false);
  assert.equal(leaks(watching.raw), false);

  const submitted = await fleet.axi(worker, "click --selector '#submit'");
  assert.equal(submitted.code, 0, submitted.text);
  await until("a picture after the page moved on", () =>
    watching.messages.slice(firstHidden).find(isFrame),
  );
  await page.locator("#note").waitFor({ state: "hidden" });
  assert.match(
    (await page.locator("#screen").getAttribute("src")) ?? "",
    /^data:image\/jpeg;base64,/,
  );
});

test("a worker's viewer lists a tab with stored values hidden, and the captain's viewer shows them and still draws while a field holds the credential", async () => {
  vault = new FakeVault([GOOD]);
  fleet = await BrowserHerdr.start({ browser: true, vault });
  const [worker] = await fleet.workers(["Sign in to the portal"]);
  assert.ok(worker !== undefined);
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  await fleet.startMain();
  const main = await fleet.mainWorkspace();
  const account = fleet.site.url(
    `/account?as=${encodeURIComponent(USERNAME)}`,
    "login.example.test",
  );
  assert.equal((await fleet.axi(worker, `open '${account}'`)).code, 0);

  const own = await fleet.viewerOf(worker.workspace);
  const scoped = await fleet.listingOf(own);
  assert.equal(scoped.tabs.length, 1);
  assert.match(String(scoped.tabs[0]?.["url"]), /\/account\?as=\[hidden\]$/);
  assert.equal(scoped.tabs[0]?.["title"], "Account of [hidden]");
  assert.equal(leaks(scoped.body), false);

  const summoned = await fleet.axi(worker, "read --captain 'check the account'");
  assert.equal(summoned.code, 0, summoned.text);
  await until("the Browser tab in main's workspace", async () =>
    (await fleet.tabLabels(main)).includes("Browser") ? true : undefined,
  );
  const captain = await fleet.viewerOf(main);
  const page = await fleet.chrome.pages();
  const shown = (await fleet.listingOf(captain)).tabs[0];
  assert.equal(shown?.["url"], page[0]?.url);
  assert.equal(shown?.["title"], `Account of ${USERNAME}`);

  const portal = fleet.site.url("/portal", "login.example.test");
  assert.equal((await fleet.axi(worker, `open '${portal}'`)).code, 0);
  assert.equal((await fleet.axi(worker, "login")).code, 0);
  const target = await tabId();
  const theirs = await watch(captain, target);
  await until("a picture in the captain's viewer", () => theirs.messages.find(isFrame));
  assert.equal(theirs.messages.some(isHidden), false);
  const mine = await watch(own, target);
  const first = await until("the first message of the worker's viewer", () => mine.messages[0]);
  assert.equal(isHidden(first), true);
  assert.equal(isFrame(first), false);
});
