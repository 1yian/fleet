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

interface Worker {
  readonly card: Card;
  readonly session: Session;
}

beforeEach(async () => {
  chrome = await StandInChrome.start();
  proxy = await TcpProxy.start(chrome.port);
  site = await TestSite.start();
  cardd = await Cardd.start({}, ["--browser", JSON.stringify({ cdp: proxy.endpoint })]);
  const mainToken = cardd.addLane("main");
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
  return { card, session: await cardd.connect(await begin(main, card, "browse")) };
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

  const aimed = { target: theirs, tab: theirs, card: second.card.id };
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
    first.session.call("browser.release", { card: second.card.id }),
    /worker sessions cannot call browser.release/,
  );
  await assert.rejects(
    first.session.call("browser.view", {}),
    /worker sessions cannot call browser.view/,
  );
  assert.equal((await chrome.pages()).length, 1);
});

test("a second mate can neither view the browser nor release another lane's card", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  try {
    const own = await worker("Users see one scrollbar");
    await act(own, { action: "open", url: site.url("/a") });
    await assert.rejects(cleo.call("browser.view", {}), /only main can view the shared browser/);
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

test("a browser that is down does not block release, and its tabs are closed once it is back", async () => {
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

  await main.call("close.begin", { card: first.card.id, landed: false });
  await main.call("close.finish", {
    card: first.card.id,
    mode: "dropped",
    text: "gone",
    archives: [],
    left: [],
  });
  await proxy.listen();
  assert.match(await act(kept, { action: "read" }), /bravo page/);
  assert.deepEqual(
    (await chrome.pages()).map((page) => new URL(page.url).pathname),
    ["/b"],
  );
});
