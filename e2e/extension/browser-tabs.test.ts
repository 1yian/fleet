import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BROWSER_OPS, Cdp, check, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { StandInChrome, TcpProxy } from "../support/chrome.ts";
import { begin, newCard } from "../support/fleet.ts";
import { isRecord } from "../support/json.ts";
import { TestSite } from "../support/site.ts";

const WAIT_MS = 15_000;

let chrome: StandInChrome;
let proxy: TcpProxy;
let site: TestSite;
let cardd: Cardd;
let main: Session;
let mainToken: string;

interface Worker {
  readonly card: Card;
  readonly token: string;
  readonly session: Session;
}

beforeEach(async () => {
  chrome = await StandInChrome.start();
  proxy = await TcpProxy.start(chrome.port);
  site = await TestSite.start();
  cardd = await Cardd.start({}, ["--browser", JSON.stringify({ cdp: proxy.endpoint })]);
  mainToken = cardd.addLane("main");
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  main = await cardd.connect(mainToken);
});
afterEach(async () => {
  const stopped = await Promise.allSettled([
    main.close(),
    cardd.stop(),
    proxy.stop(),
    chrome.stop(),
    site.stop(),
  ]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function worker(title: string): Promise<Worker> {
  const card = await newCard(main, title);
  const token = await begin(main, card, "browse");
  return { card, token, session: await cardd.connect(token) };
}

async function restartCardd(...who: Worker[]): Promise<Worker[]> {
  await cardd.restart();
  main = await cardd.connect(mainToken);
  return Promise.all(
    who.map(async (each) => ({ ...each, session: await cardd.connect(each.token) })),
  );
}

async function act(who: Worker, args: Record<string, unknown>): Promise<string> {
  return check(BROWSER_OPS.browser.result, await who.session.call("browser", args)).text;
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const viewOf = async (): Promise<
  ReturnType<typeof check<(typeof BROWSER_OPS)["browser.view"]["result"]>>
> => check(BROWSER_OPS["browser.view"].result, await main.call("browser.view", {}));

const released = async (card: number): Promise<{ closed: number; note: string | null }> =>
  check(BROWSER_OPS["browser.release"].result, await main.call("browser.release", { card }));

test("two cards each get their own labelled tab", async () => {
  const first = await worker("Users see one scrollbar");
  const second = await worker("Users see one footer");
  await act(first, { action: "open", url: site.url("/a") });
  await act(second, { action: "open", url: site.url("/b") });
  assert.equal((await chrome.pages()).length, 2);
  const titles = await until(async () => {
    const found = (await chrome.pages()).map((page) => page.title).sort();
    return found.every((title) => title.startsWith("c-")) ? found : undefined;
  }, "both tabs to carry their labels");
  assert.deepEqual(titles, [
    "c-1 users-see-one-scrollbar - Alpha",
    "c-2 users-see-one-footer - Bravo",
  ]);
  const view = await viewOf();
  assert.equal(view.endpoint, proxy.endpoint);
  assert.deepEqual(
    view.tabs.map(({ card, label }) => `${String(card)} ${label}`),
    ["1 c-1 users-see-one-scrollbar", "2 c-2 users-see-one-footer"],
  );
});

test("a card cannot read, drive or close another card's tab", async () => {
  const first = await worker("Users see one scrollbar");
  const second = await worker("Users see one footer");
  await act(first, { action: "open", url: site.url("/a") });
  await act(second, { action: "open", url: site.url("/b") });
  const theirs = (await viewOf()).tabs.find((tab) => tab.card === second.card.id)?.target ?? "";
  assert.notEqual(theirs, "");

  const aimed = { target: theirs, tab: theirs };
  assert.equal(
    await act(first, { action: "eval", expression: "document.body.dataset.owner", ...aimed }),
    '"a"',
  );
  assert.match(await act(first, { action: "read", ...aimed }), /alpha page/);
  await act(first, { action: "click", selector: "#count", ...aimed });
  assert.equal(await act(first, { action: "read", selector: "#n" }), "1");
  assert.match(await act(second, { action: "read" }), /bravo page/);

  await act(first, { action: "close", ...aimed });
  assert.deepEqual(
    (await chrome.pages()).map((page) => new URL(page.url).pathname),
    ["/b"],
  );
  assert.match(await act(second, { action: "read" }), /bravo page/);
  await assert.rejects(act(first, { action: "read" }), /you have no tab yet/);
  await assert.rejects(
    act(second, { action: "close", card: first.card.id }),
    new RegExp(`your tab is c-${String(second.card.id)}'s: do not name another card`),
  );
  assert.match(await act(second, { action: "read" }), /bravo page/);

  await assert.rejects(
    first.session.call("browser.release", { card: second.card.id }),
    /worker sessions cannot call browser.release/,
  );
  const theirView = check(
    BROWSER_OPS["browser.view"].result,
    await second.session.call("browser.view", {}),
  );
  assert.deepEqual(
    theirView.tabs.map(({ card }) => card),
    [second.card.id],
  );
  assert.equal((await chrome.pages()).length, 1);
});

test("a second mate sees no tab of another lane's card and cannot release it", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  try {
    const own = await worker("Users see one scrollbar");
    await act(own, { action: "open", url: site.url("/a") });
    const seen = check(BROWSER_OPS["browser.view"].result, await cleo.call("browser.view", {}));
    assert.deepEqual(seen.tabs, []);
    assert.deepEqual(
      check(
        BROWSER_OPS["browser.view"].result,
        await cleo.call("browser.view", { card: own.card.id }),
      ).tabs,
      [],
    );
    await assert.rejects(
      cleo.call("browser.release", { card: own.card.id }),
      new RegExp(`c-${String(own.card.id)} is in another lane; ask main`),
    );
    assert.equal((await chrome.pages()).length, 1);
  } finally {
    await cleo.close();
  }
});

async function popupRefusal(): Promise<{ created: string[]; destroyed: string[] }> {
  const watcher = await Cdp.connect(chrome.endpoint);
  const created: string[] = [];
  const destroyed: string[] = [];
  watcher.listen(({ method, params }) => {
    const info = isRecord(params) ? params : {};
    const target = isRecord(info["targetInfo"]) ? info["targetInfo"] : {};
    if (method === "Target.targetCreated" && target["openerId"] !== undefined)
      created.push(String(target["targetId"]));
    if (method === "Target.targetDestroyed") destroyed.push(String(info["targetId"]));
  });
  await watcher.send("Target.setDiscoverTargets", { discover: true });
  const opener = await worker("Users see one scrollbar");
  await act(opener, { action: "open", url: site.url("/popup") });
  await act(opener, {
    action: "eval",
    expression:
      'window.addEventListener("click", (event) => event.stopPropagation(), true); document.getElementById("blank").click()',
  });
  await until(
    () =>
      Promise.resolve(
        created.length > 0 && destroyed.includes(created[0] ?? "") ? true : undefined,
      ),
    "the new window to be created and then closed",
  );
  watcher.close();
  return { created, destroyed };
}

test("a window the page opens never stays: window.open and target=_blank fold into the tab", async () => {
  const opener = await worker("Users see one scrollbar");
  await act(opener, { action: "open", url: site.url("/popup") });
  assert.equal(
    await act(opener, { action: "eval", expression: 'window.open("/b") === window' }),
    "true",
  );
  assert.equal((await chrome.pages()).length, 1);
  await until(
    async () => ((await act(opener, { action: "read" })).includes("bravo page") ? true : undefined),
    "window.open to load in the same tab",
  );
  assert.equal((await chrome.pages()).length, 1);

  await act(opener, { action: "open", url: site.url("/popup") });
  await act(opener, { action: "click", selector: "#blank" });
  await until(
    async () => ((await act(opener, { action: "read" })).includes("bravo page") ? true : undefined),
    "the _blank link to load in the same tab",
  );
  assert.equal((await chrome.pages()).length, 1);
});

test("a window that gets past the page script is closed by cardd", async () => {
  const { created } = await popupRefusal();
  assert.equal(created.length, 1);
  assert.equal((await chrome.pages()).length, 1);
});

test("close and release close the card's tab, and a rerun finds nothing left", async () => {
  const first = await worker("Users see one scrollbar");
  const second = await worker("Users see one footer");
  await act(first, { action: "open", url: site.url("/a") });
  await act(second, { action: "open", url: site.url("/b") });
  assert.equal(await act(first, { action: "close" }), "Closed your tab.");
  assert.equal((await chrome.pages()).length, 1);
  assert.deepEqual(await released(second.card.id), { closed: 1, note: null });
  assert.equal((await chrome.pages()).length, 0);
  assert.deepEqual(await released(second.card.id), { closed: 0, note: null });
  assert.equal((await viewOf()).tabs.length, 0);
});

const pathsOpen = async (): Promise<string[]> =>
  (await chrome.pages()).map((page) => new URL(page.url).pathname);

async function closeCard(card: number): Promise<void> {
  await main.call("close.begin", { card, landed: false });
  await main.call("close.finish", { card, mode: "dropped", text: "gone", archives: [], left: [] });
}

test("a browser that is down does not block release, and a viewer poll closes the ended card's tab once it is back", async () => {
  const first = await worker("Users see one scrollbar");
  await act(first, { action: "open", url: site.url("/a") });
  const kept = await worker("Users see one footer");
  await act(kept, { action: "open", url: site.url("/b") });
  await proxy.stop();
  const down = await released(first.card.id);
  assert.equal(down.closed, 0);
  assert.match(down.note ?? "", /the shared browser is unreachable/);
  assert.match(down.note ?? "", /1 tab of c-1 stay open/);
  await assert.rejects(act(kept, { action: "read" }), /the shared browser is unreachable/);
  await closeCard(first.card.id);
  assert.deepEqual((await pathsOpen()).sort(), ["/a", "/b"]);

  await proxy.listen();
  await until(async () => {
    await viewOf();
    return (await pathsOpen()).length === 1 ? true : undefined;
  }, "a viewer poll to close the ended card's tab");
  assert.deepEqual(await pathsOpen(), ["/b"]);
  assert.deepEqual(
    (await viewOf()).tabs.map((tab) => tab.card),
    [kept.card.id],
  );
  assert.match(await act(kept, { action: "read" }), /bravo page/);
});

test("a card whose tab could not be closed during a restart gets a fresh tab, not the old one", async () => {
  const restarted = await worker("Users see one scrollbar");
  await act(restarted, { action: "open", url: site.url("/a") });
  const old = (await viewOf()).tabs[0]?.target ?? "";
  await proxy.stop();
  assert.match((await released(restarted.card.id)).note ?? "", /1 tab of c-1 stay open/);
  await proxy.listen();

  assert.match(await act(restarted, { action: "open", url: site.url("/b") }), /Bravo/);
  const view = await viewOf();
  assert.equal(view.tabs.length, 1);
  assert.notEqual(view.tabs[0]?.target, old);
  assert.deepEqual(await pathsOpen(), ["/b"]);
  assert.equal(
    await act(restarted, { action: "eval", expression: "document.body.dataset.owner" }),
    '"b"',
  );
});

test("an explicit close while the browser is down says the tab stays open, and works once it is back", async () => {
  const own = await worker("Users see one scrollbar");
  await act(own, { action: "open", url: site.url("/a") });
  await proxy.stop();

  await assert.rejects(
    act(own, { action: "close" }),
    /Your tab was not closed and stays open\..*the shared browser is unreachable/,
  );
  assert.deepEqual(await pathsOpen(), ["/a"]);

  await proxy.listen();
  await act(own, { action: "close" });
  assert.deepEqual(await pathsOpen(), []);
  assert.equal(await act(own, { action: "close" }), "You had no tab open.");
  assert.equal((await viewOf()).tabs.length, 0);
});

test("a release that could not reach the browser closes the retired tab when it is retried after the browser is back", async () => {
  const own = await worker("Users see one scrollbar");
  await act(own, { action: "open", url: site.url("/a") });
  await proxy.stop();
  assert.match((await released(own.card.id)).note ?? "", /1 tab of c-1 stay open/);
  assert.deepEqual(await pathsOpen(), ["/a"]);

  await proxy.listen();
  assert.equal((await released(own.card.id)).note, null);
  assert.deepEqual(await pathsOpen(), []);
  assert.deepEqual(await released(own.card.id), { closed: 0, note: null });
});

test("open and read never reuse a tab that was opened before the card's current attempt began", async () => {
  const own = await worker("Users see one scrollbar");
  await act(own, { action: "open", url: site.url("/a") });
  const old = (await viewOf()).tabs[0]?.target ?? "";
  cardd.startAttemptAfterTabs(own.card.id);

  await act(own, { action: "open", url: site.url("/b") });
  const fresh = (await viewOf()).tabs;
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0]?.target, old);
  assert.deepEqual(await pathsOpen(), ["/b"]);

  cardd.startAttemptAfterTabs(own.card.id);
  await assert.rejects(act(own, { action: "read" }), /you have no tab yet/);
  assert.deepEqual(await pathsOpen(), []);
});

test("a tab that could not be closed stays retired across a cardd restart, is closed, and is never reused", async () => {
  const restarted = await worker("Users see one scrollbar");
  await act(restarted, { action: "open", url: site.url("/a") });
  const old = (await viewOf()).tabs[0]?.target ?? "";
  await proxy.stop();
  assert.match((await released(restarted.card.id)).note ?? "", /1 tab of c-1 stay open/);
  const [again] = await restartCardd(restarted);
  assert.ok(again !== undefined);
  assert.deepEqual(await pathsOpen(), ["/a"]);

  await proxy.listen();
  await until(async () => {
    await viewOf();
    return (await pathsOpen()).length === 0 ? true : undefined;
  }, "a viewer poll to close the retired tab");
  assert.match(await act(again, { action: "open", url: site.url("/b") }), /Bravo/);

  const view = await viewOf();
  assert.equal(view.tabs.length, 1);
  assert.notEqual(view.tabs[0]?.target, old);
  assert.deepEqual(await pathsOpen(), ["/b"]);
});
