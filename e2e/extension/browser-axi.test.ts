import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BrowserHerdr, until } from "../support/browser-herdr.ts";
import { parseRecord } from "../support/json.ts";
import { FakeVault } from "../support/fake-vault.ts";

let fleet: BrowserHerdr;
let vault: FakeVault | undefined;

afterEach(async (t) => {
  await fleet.stop(t);
  vault?.dispose();
  vault = undefined;
});

const BROWSER = "Browser";

test("a worker that does not need the captain gets the viewer in its own workspace, scoped to its own tab", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker, other] = await fleet.workers(["Users see one scrollbar", "Users see one footer"]);
  assert.ok(worker !== undefined && other !== undefined);
  await fleet.startMain();
  const main = await fleet.mainWorkspace();

  const theirs = await fleet.axi(other, `open ${fleet.site.url("/b")}`);
  assert.equal(theirs.code, 0, theirs.text);
  const opened = await fleet.axi(worker, `open ${fleet.site.url("/a")}`);
  assert.equal(opened.code, 0, opened.text);
  assert.match(String(parseRecord(opened.text.split("\n")[0] ?? "")["view"]), /your own workspace/);

  await until("the Browser tab in the worker's workspace", async () =>
    (await fleet.tabLabels(worker.workspace)).includes(BROWSER) ? true : undefined,
  );
  const address = await fleet.viewerOf(worker.workspace);
  assert.deepEqual(await fleet.tabsSeenBy(address), [
    `c-${String(worker.card.id)} users-see-one-scrollbar`,
  ]);
  const pages = await fleet.chrome.pages();
  assert.equal(pages.length, 2);
  const foreign = pages.find((page) => page.url.endsWith("/b"));
  assert.ok(foreign !== undefined);
  assert.equal(await fleet.streamStatus(address, foreign.id), 404);
  assert.equal(await fleet.inputStatus(address, foreign.id), 404);
  assert.equal((await fleet.tabLabels(main)).includes(BROWSER), false);
});

test("--captain opens the viewer in main's workspace and not in the worker's, and main hears why", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker] = await fleet.workers(["Pay the invoice"]);
  assert.ok(worker !== undefined);
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  await fleet.startMain();
  const main = await fleet.mainWorkspace();

  const opened = await fleet.axi(
    worker,
    `open ${fleet.site.url("/a")} --captain 'the bank asks for a passkey'`,
  );
  assert.equal(opened.code, 0, opened.text);
  const record = parseRecord(opened.text.split("\n")[0] ?? "");
  assert.match(String(record["view"]), /main's workspace/);

  await until("the Browser tab in main's workspace", async () =>
    (await fleet.tabLabels(main)).includes(BROWSER) ? true : undefined,
  );
  const address = await fleet.viewerOf(main);
  assert.deepEqual(await fleet.tabsSeenBy(address), [
    `c-${String(worker.card.id)} pay-the-invoice`,
  ]);
  assert.equal((await fleet.tabLabels(worker.workspace)).includes(BROWSER), false);

  const heard = await fleet.h.waitForCall(0, "mate");
  assert.match(
    heard.map((turn) => turn.text).join("\n"),
    new RegExp(
      `c-${String(worker.card.id)} pay-the-invoice needs the captain in its browser tab: the bank asks for a passkey`,
    ),
  );
});

test("a login with no entry opens the viewer in main's workspace and exits 3", async () => {
  vault = new FakeVault([]);
  fleet = await BrowserHerdr.start({ browser: true, vault });
  const [worker] = await fleet.workers(["Sign in to the portal"]);
  assert.ok(worker !== undefined);
  fleet.h.onModel(() => ({ text: "will ask the captain" }), "mate");
  await fleet.startMain();
  const main = await fleet.mainWorkspace();
  const login = fleet.site.url("/login", "login.nothing.test");

  assert.equal((await fleet.axi(worker, `open '${login}'`)).code, 0);
  const missing = await fleet.axi(worker, "login");

  assert.equal(missing.code, 3, missing.text);
  assert.match(missing.text, /not found: the Logins project has no entry for login\.nothing\.test/);
  await until("the Browser tab in main's workspace", async () =>
    (await fleet.tabLabels(main)).includes(BROWSER) ? true : undefined,
  );
  const seen = await fleet.tabsSeenBy(await fleet.viewerOf(main));
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", new RegExp(`^c-${String(worker.card.id)} sign-in`));
  assert.equal((await fleet.tabLabels(main)).filter((label) => label === BROWSER).length, 1);

  const heard = (await fleet.h.waitForCall(0, "mate")).map((turn) => turn.text).join("\n");
  assert.match(heard, /needs a Bitwarden login for login\.nothing\.test/);
  assert.doesNotMatch(heard, /needs the captain in its browser tab/);
});

test("a mate drives a card's tab from its lane home with --card, and no token is in the environment or the viewer's command", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker] = await fleet.workers(["Users see one scrollbar"]);
  assert.ok(worker !== undefined);
  const home = {
    FLEET_BROWSER_URL: "",
    FLEET_BROWSER_TOKEN: "",
    FLEET_BROWSER_HOME: fleet.scratch.root,
  };

  const bare = await fleet.axi(worker, `open ${fleet.site.url("/a")}`, home);
  assert.equal(bare.code, 1, bare.text);
  assert.match(String(parseRecord(bare.text.split("\n")[0] ?? "")["error"]), /name the card/);
  assert.deepEqual(await fleet.chrome.pages(), []);

  const opened = await fleet.axi(
    worker,
    `open ${fleet.site.url("/a")} --card ${String(worker.card.id)}`,
    home,
  );
  assert.equal(opened.code, 0, opened.text);
  assert.equal((await fleet.chrome.pages()).length, 1);
  await until("the Browser tab", async () =>
    (await fleet.tabLabels(worker.workspace)).includes(BROWSER) ? true : undefined,
  );
  const seen = await fleet.tabsSeenBy(await fleet.viewerOf(worker.workspace));
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", new RegExp(`^c-${String(worker.card.id)} `));
  const pane = await fleet.viewerPane(worker.workspace);
  assert.equal((await fleet.lab.history(pane)).includes(fleet.mainToken), false);
});

test("a fleet with no shared browser: browser-axi says so, exits nonzero, and points to no browser", async () => {
  fleet = await BrowserHerdr.start({ browser: false });
  const [worker] = await fleet.workers(["Look at the site"]);
  assert.ok(worker !== undefined);

  const opened = await fleet.axi(worker, `open ${fleet.site.url("/a")}`);
  const status = await fleet.axi(worker, "");

  for (const run of [opened, status]) {
    assert.equal(run.code, 4, run.text);
    const record = parseRecord(run.text.split("\n")[0] ?? "");
    assert.match(String(record["error"]), /no shared browser/);
    assert.match(run.text, /--browser/);
    assert.doesNotMatch(run.text, /safari|osascript/i);
  }
  assert.deepEqual(await fleet.chrome.pages(), []);
  assert.equal((await fleet.tabLabels(worker.workspace)).includes(BROWSER), false);
});

test("closing the tab also closes the worker's own Browser viewer tab, and leaves another worker's viewer alone", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker, other] = await fleet.workers(["Users see one scrollbar", "Users see one footer"]);
  assert.ok(worker !== undefined && other !== undefined);
  for (const each of [worker, other]) {
    const opened = await fleet.axi(each, `open ${fleet.site.url("/a")}`);
    assert.equal(opened.code, 0, opened.text);
    await until("the Browser tab", async () =>
      (await fleet.tabLabels(each.workspace)).includes(BROWSER) ? true : undefined,
    );
  }
  const address = await fleet.viewerOf(worker.workspace);
  const theirs = await fleet.viewerOf(other.workspace);

  const closed = await fleet.axi(worker, "close");

  assert.equal(closed.code, 0, closed.text);
  const record = parseRecord(closed.text.split("\n")[0] ?? "");
  assert.equal(record["result"], "Closed your tab.");
  assert.match(String(record["view"]), /^the Browser tab in your own workspace is closed/);
  await until("the worker's Browser tab to close", async () =>
    (await fleet.tabLabels(worker.workspace)).includes(BROWSER) ? undefined : true,
  );
  await until("the worker's viewer to stop", async () =>
    (await fetch(address).then(
      () => false,
      () => true,
    ))
      ? true
      : undefined,
  );
  assert.equal((await fleet.tabLabels(other.workspace)).includes(BROWSER), true);
  assert.equal((await fleet.tabsSeenBy(theirs)).length, 1);

  const again = await fleet.axi(worker, "close");
  assert.equal(again.code, 0, again.text);
  assert.equal(parseRecord(again.text.split("\n")[0] ?? "")["result"], "You had no tab open.");

  const reopened = await fleet.axi(worker, `open ${fleet.site.url("/b")}`);
  assert.equal(reopened.code, 0, reopened.text);
  await until("a new Browser tab", async () =>
    (await fleet.tabLabels(worker.workspace)).includes(BROWSER) ? true : undefined,
  );
  assert.equal((await fleet.tabsSeenBy(await fleet.viewerOf(worker.workspace))).length, 1);
});
