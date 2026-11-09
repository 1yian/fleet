import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chromium, type Browser as Client, type Locator, type Page } from "playwright";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import {
  pointInPicture,
  startViewer,
  stopViewers,
  waitFor,
  type Viewers,
} from "../support/viewer.ts";

const MODES: readonly (readonly [string, string[], boolean])[] = [
  ["the captain's viewer", ["--captain"], false],
  ["a gated viewer", [], false],
  ["a worker-owned gated viewer", [], true],
];

const ADDRESS = "Address of the fleet browser tab";

let lab: BrowserLab;
let client: Client | undefined;
const viewers: Viewers = [];
let page: Page;
let worker: RawWorker;
let url: string;

afterEach(async () => {
  const stopped = await Promise.allSettled([...stopViewers(viewers), client?.close(), lab.stop()]);
  client = undefined;
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function begin(flags: string[], workerOwned = false): Promise<void> {
  lab = await BrowserLab.start();
  worker = await lab.worker("Users go back");
  url = (
    await startViewer(lab, viewers, flags, {}, workerOwned ? { token: worker.token } : undefined)
  ).url;
  client = await chromium.launch();
  page = await client.newPage({ viewport: { width: 1400, height: 900 } });
}

const back = (): Locator => page.getByRole("button", { name: "Back in this tab" });
const forward = (): Locator => page.getByRole("button", { name: "Forward in this tab" });
const reload = (): Locator => page.getByRole("button", { name: "Reload this tab" });
const address = (): Locator => page.getByRole("textbox", { name: ADDRESS });

async function show(): Promise<void> {
  await page.goto(url);
  await waitFor(
    async () => (await page.locator("#live").textContent()) === "live",
    "the picture to be live",
  );
}

async function pathOf(who: RawWorker = worker): Promise<string> {
  const found: unknown = JSON.parse(
    await who.act({ action: "eval", expression: "location.pathname" }),
  );
  return String(found);
}

const onPath = (path: string): Promise<void> =>
  waitFor(async () => (await pathOf()) === path, `the tab to be on ${path}`);

const enabled = async (button: Locator): Promise<boolean> => !(await button.isDisabled());

const stateOf = (): Promise<string> =>
  Promise.all([back(), forward(), reload()].map(enabled)).then((flags) =>
    flags.map((flag) => (flag ? "on" : "off")).join(" "),
  );

const toolbarIs = (wanted: string): Promise<void> =>
  waitFor(async () => (await stateOf()) === wanted, `back, forward, reload to be ${wanted}`);

async function clickInPicture(x: number, y: number): Promise<void> {
  const size: unknown = JSON.parse(
    await worker.act({ action: "eval", expression: "[innerWidth, innerHeight]" }),
  );
  if (!Array.isArray(size)) throw new Error("the page size is not a pair");
  const at = await pointInPicture(page, { width: Number(size[0]), height: Number(size[1]) }, x, y);
  await page.mouse.click(at.x, at.y);
}

const clickLink = (): Promise<void> => clickInPicture(40, 30);

const accelerator = process.platform === "darwin" ? "Meta" : "Control";
const backKey = process.platform === "darwin" ? "Meta+BracketLeft" : "Alt+ArrowLeft";
const forwardKey = process.platform === "darwin" ? "Meta+BracketRight" : "Alt+ArrowRight";

for (const [who, flags, workerOwned] of MODES) {
  test(`${who}: Back, Forward and Reload act on the worker's own tab, in the one history that the worker and the captain share`, async () => {
    await begin(flags, workerOwned);
    await worker.act({ action: "open", url: lab.site.url("/links") });
    await show();

    assert.equal(await address().inputValue(), lab.site.url("/links"));
    await toolbarIs("off off on");

    await clickLink();
    await onPath("/b");
    await toolbarIs("on off on");
    assert.equal(await address().inputValue(), lab.site.url("/b"));

    await worker.act({ action: "open", url: lab.site.url("/pad") });
    await waitFor(
      async () => (await address().inputValue()) === lab.site.url("/pad"),
      "the address to follow the worker",
    );

    await back().click();
    await onPath("/b");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "capture");
    await toolbarIs("on on on");
    assert.equal(await address().inputValue(), lab.site.url("/b"));
    await back().click();
    await onPath("/links");
    await toolbarIs("off on on");
    await forward().click();
    await onPath("/b");
    await forward().click();
    await onPath("/pad");
    await toolbarIs("on off on");

    await worker.act({ action: "open", url: lab.site.url("/a") });
    await clickInPicture(120, 100);
    await waitFor(
      async () => (await worker.act({ action: "read", selector: "#n" })) === "1",
      "one count",
    );
    await reload().click();
    await waitFor(
      async () => (await worker.act({ action: "read", selector: "#n" })) === "0",
      "the reload",
    );
    assert.equal(await pathOf(), "/a");
  });

  test(`${who}: the address field loads a typed address in the same tab, and refuses what the tab may not open`, async () => {
    await begin(flags, workerOwned);
    await worker.act({ action: "open", url: lab.site.url("/a") });
    await show();

    await address().fill(lab.site.url("/b"));
    await address().press("Enter");
    await onPath("/b");
    await toolbarIs("on off on");
    await waitFor(
      async () => (await address().inputValue()) === lab.site.url("/b"),
      "the address to show the new page",
    );

    for (const [typed, scheme] of [
      ["javascript:alert(1)", "javascript:"],
      ["file:///etc/hosts", "file:"],
      ["chrome://version", "chrome:"],
    ] as const) {
      await address().fill(typed);
      await address().press("Enter");
      const note = page.getByRole("alert");
      await waitFor(
        async () =>
          (await note.textContent()) === `only http and https pages can be opened, not ${scheme}`,
        `the refusal of ${typed}`,
      );
      assert.equal(await pathOf(), "/b");
      assert.equal(await address().inputValue(), typed);
      await address().press("Escape");
      assert.equal(await address().inputValue(), lab.site.url("/b"));
    }
    await back().click();
    await onPath("/a");
    await toolbarIs("off on on");
  });

  test(`${who}: an address typed without a scheme is loaded over https, and Back recovers from a page that did not load`, async () => {
    await begin(flags, workerOwned);
    await worker.act({ action: "open", url: lab.site.url("/a") });
    await show();

    const bare = `127.0.0.1:${String(lab.site.port)}/b`;
    await address().fill(bare);
    await address().press("Enter");
    await waitFor(
      async () =>
        ((await page.getByRole("alert").textContent()) ?? "").startsWith(
          `could not load https://${bare}`,
        ),
      "the note that names the address it tried",
    );
    await waitFor(async () => await enabled(back()), "Back to be offered");
    await back().click();
    await onPath("/a");
  });

  test(`${who}: the mouse's back and forward buttons over the picture go back and forward in the tab, and leave the viewer page where it is`, async () => {
    await begin(flags, workerOwned);
    await worker.act({ action: "open", url: lab.site.url("/links") });
    await show();
    await clickLink();
    await onPath("/b");
    const box = await page.locator("#screen").boundingBox();
    assert.ok(box !== null);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const session = await page.context().newCDPSession(page);
    const press = async (button: "back" | "forward"): Promise<void> => {
      for (const type of ["mousePressed", "mouseReleased"] as const)
        await session.send("Input.dispatchMouseEvent", {
          ...point,
          type,
          button,
          buttons: type === "mousePressed" ? (button === "back" ? 8 : 16) : 0,
          clickCount: 1,
        });
    };

    await press("back");
    await onPath("/links");
    await press("forward");
    await onPath("/b");
    assert.equal(page.url(), new URL("/", url).href);
  });

  test(`${who}: the keyboard goes back, forward and reloads the tab, and Ctrl or Cmd+L edits its address, with the viewer page left alone`, async () => {
    await begin(flags, workerOwned);
    await worker.act({ action: "open", url: lab.site.url("/links") });
    await show();
    await page.evaluate(() => Reflect.set(window, "kept", "the viewer page"));
    await clickLink();
    await onPath("/b");
    await clickInPicture(300, 300);

    await page.keyboard.press(backKey);
    await onPath("/links");
    await page.keyboard.press(forwardKey);
    await onPath("/b");

    await worker.act({ action: "open", url: lab.site.url("/a") });
    for (const key of ["F5", `${accelerator}+KeyR`]) {
      await clickInPicture(120, 100);
      await waitFor(
        async () => (await worker.act({ action: "read", selector: "#n" })) === "1",
        "one count",
      );
      await page.keyboard.press(key);
      await waitFor(
        async () => (await worker.act({ action: "read", selector: "#n" })) === "0",
        `${key} to reload the tab`,
      );
    }

    await page.keyboard.press(`${accelerator}+KeyL`);
    await waitFor(
      async () => (await page.evaluate(() => document.activeElement?.id)) === "address",
      "the address field to take focus",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "");
    assert.equal(
      await page.evaluate((): unknown => Reflect.get(window, "kept")),
      "the viewer page",
    );
  });
}

test("input queued during a slow worker load reaches its form without a timeout", { timeout: 60_000 }, async () => {
  await begin(["--captain"]);
  await worker.act({ action: "open", url: lab.site.url("/landing") });
  await show();
  await page.locator("#capture").focus();
  const opening = worker.act({ action: "open", url: lab.site.url("/slow-input") });
  await waitFor(() => Promise.resolve(lab.site.holding() === 1), "the image to hold the page's load event");
  const delivered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/input",
    { timeout: 45_000 },
  );
  await page.keyboard.type("queued");
  assert.match(await opening, /still loading after 30 s/);
  lab.site.release();
  assert.equal((await delivered).status(), 204);
  await waitFor(
    async () => (await worker.act({ action: "eval", expression: 'document.getElementById("field").value' })) === '"queued"',
    "all queued text to reach the new form",
  );
  assert.equal(await page.getByRole("alert").isVisible(), false);
  assert.equal(await pathOf(), "/slow-input");
});

test("viewer input waits for a queued Back and reaches the restored form", async () => {
  await begin(["--captain"]);
  await worker.act({ action: "open", url: lab.site.url("/a") });
  await worker.act({ action: "open", url: lab.site.url("/landing") });
  await show();
  let releaseNavigation = (): void => {};
  const released = new Promise<void>((resolve) => { releaseNavigation = resolve; });
  let navigationReady = (): void => {};
  const ready = new Promise<void>((resolve) => { navigationReady = resolve; });
  let navigationFinished = false;
  let earlyInput = false;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/input" && !navigationFinished) earlyInput = true;
  });
  await page.route("**/api/nav", async (route) => {
    const response = await route.fetch();
    navigationReady();
    await released;
    navigationFinished = true;
    await route.fulfill({ response });
  });
  const opening = worker.act({ action: "open", url: lab.site.url("/held") });
  await waitFor(() => Promise.resolve(lab.site.holding() === 1), "the held load to start");
  await back().click();
  await page.keyboard.type("queued");
  lab.site.release();
  await opening;
  await ready;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  releaseNavigation();
  await waitFor(async () => (await worker.act({ action: "eval", expression: 'document.querySelector("input").value' })) === '"queued"', "the queued text to reach the restored form");
  assert.equal(earlyInput, false, "input reached Chrome before Back finished");
  assert.equal(await pathOf(), "/landing");
});

test("a worker viewer cannot declare a host or navigate another worker's tab", async () => {
  await begin([], true);
  await worker.act({ action: "open", url: lab.site.url("/a") });
  const other = await lab.worker("Users keep their own tab");
  await other.act({ action: "open", url: lab.site.url("/b") });
  await show();
  await assert.rejects(
    worker.session.call("browser", { action: "reload", host: "maverick" }),
    /do not name a host/,
  );
  const tab = (await lab.chrome.pages()).find(({ title }) =>
    title.startsWith(`c-${String(other.card.id)} `),
  );
  assert.ok(tab !== undefined);
  const response = await page.request.post(new URL("/api/nav", url).href, {
    data: { target: tab.id, action: "open", url: lab.site.url("/pad") },
  });
  assert.equal(response.status(), 404);
  assert.equal(await pathOf(other), "/b");
  assert.equal(await pathOf(), "/a");
});

test("a Mac viewer uses Cmd+[ and Cmd+] for the shared tab and Cmd+L for its address", async () => {
  await begin(["--captain"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await worker.act({ action: "open", url: lab.site.url("/links") });
  await show();
  await clickLink();
  await onPath("/b");
  await page.keyboard.press("Meta+BracketLeft");
  await onPath("/links");
  await toolbarIs("off on on");
  await page.keyboard.press("Meta+BracketRight");
  await onPath("/b");
  await page.keyboard.press("Meta+KeyL");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "address");
});

test("the worker's back, forward and reload walk the same history that the captain's clicks made", async () => {
  await begin(["--captain"]);
  await worker.act({ action: "open", url: lab.site.url("/links") });
  await assert.rejects(
    worker.act({ action: "back" }),
    /your tab has no earlier page to go back to/,
  );
  await assert.rejects(
    worker.act({ action: "forward" }),
    /your tab has no later page to go forward to/,
  );
  await show();
  await clickLink();
  await onPath("/b");

  assert.equal(await worker.act({ action: "back" }), "Went back.");
  assert.equal(await pathOf(), "/links");
  await waitFor(async () => await enabled(forward()), "the viewer to offer Forward");
  assert.equal(await worker.act({ action: "forward" }), "Went forward.");
  assert.equal(await pathOf(), "/b");
  assert.equal(await worker.act({ action: "reload" }), "Reloaded.");
  assert.equal(await pathOf(), "/b");
  await assert.rejects(
    worker.act({ action: "forward" }),
    /your tab has no later page to go forward to/,
  );
  await toolbarIs("on off on");
});

for (const [who, flags, workerOwned] of MODES) {
  test(`${who}: a Back pressed while the worker's own page is still loading is carried out after it`, async () => {
    await begin(flags, workerOwned);
    await worker.act({ action: "open", url: lab.site.url("/links") });
    await show();
    await clickLink();
    await onPath("/b");

    const opening = worker.act({ action: "open", url: lab.site.url("/held") });
    await waitFor(() => Promise.resolve(lab.site.holding() === 1), "the page to be requested");
    await back().click();
    await waitFor(async () => !(await enabled(reload())), "the toolbar to wait for the tab");
    lab.site.release();
    assert.match(await opening, /^Opened /);

    await waitFor(async () => await enabled(reload()), "the toolbar to be ready again");
    assert.equal(await pathOf(), "/b");
    await forward().click();
    await onPath("/held");
  });
}
