import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BROWSER_OPS, Cdp, check } from "@fleet/protocol";
import { chromium, type Browser as Client, type Page } from "playwright";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { tabOf, until } from "../support/login-fixtures.ts";
import { isRecord, records } from "../support/json.ts";
import { pointInPicture, startViewer, stopViewers, type Viewers } from "../support/viewer.ts";

const ENTERED = /a password entered through the viewer is still in this page's form/;
const TYPED = "S3cr3t-typed-by-the-captain";

let lab: BrowserLab;
let client: Client | undefined;
const viewers: Viewers = [];
let page: Page;
let worker: RawWorker;
let size: { width: number; height: number };
let fields = "document";
let crossFrame = false;

afterEach(async () => {
  const stopped = await Promise.allSettled([...stopViewers(viewers), client?.close(), lab.stop()]);
  client = undefined;
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function begin(flags: string[], embedding = "document"): Promise<void> {
  crossFrame = embedding === "cross-frame";
  lab = await BrowserLab.start({ isolated: crossFrame });
  worker = await lab.worker("Users sign in");
  await worker.act({ action: "open", url: lab.site.url("/entry") });
  fields = "document";
  if (embedding === "shadow" || embedding === "closed-shadow") {
    await worker.act({
      action: "eval",
      expression: `(() => {
        const host = document.createElement("div");
        host.id = "host";
        document.body.append(host);
        const root = host.attachShadow({ mode: ${JSON.stringify(embedding === "closed-shadow" ? "closed" : "open")} });
        window.fixtureRoot = root;
        root.append(document.querySelector("form"));
      })()`,
    });
    fields = "window.fixtureRoot";
  }
  if (embedding === "frame" || crossFrame) {
    await worker.act({
      action: "eval",
      expression: `new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.id = "inner";
        frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
        frame.onload = () => resolve("ready");
        ${crossFrame ? `frame.src = ${JSON.stringify(lab.site.url("/entry", "login.example.test"))};` : 'frame.srcdoc = document.querySelector("form").outerHTML;'}
        document.querySelector("form").remove();
        document.body.append(frame);
      })`,
    });
    fields = 'document.getElementById("inner").contentDocument';
  }
  const found: unknown = JSON.parse(
    await worker.act({ action: "eval", expression: "[innerWidth, innerHeight]" }),
  );
  if (!Array.isArray(found)) throw new Error("the page size is not a pair");
  size = { width: Number(found[0]), height: Number(found[1]) };
  const { url } = await startViewer(lab, viewers, flags);
  client = await chromium.launch();
  page = await client.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(url);
  await until(
    async () => ((await page.locator("#live").textContent()) === "live" ? true : undefined),
    "the picture to be live",
  );
}

async function clickField(at: { x: number; y: number }): Promise<void> {
  const point = await pointInPicture(page, size, at.x, at.y);
  await page.mouse.click(point.x, point.y);
}

const USER = { x: 170, y: 36 };
const PASSWORD_FIELD = { x: 170, y: 86 };
const REVEAL = { x: 365, y: 86 };

async function inChrome(expression: string): Promise<unknown> {
  if (crossFrame) {
    const cdp = await Cdp.connect(lab.chrome.endpoint);
    try {
      const listed = await cdp.send("Target.getTargets");
      if (!isRecord(listed)) throw new Error("Chrome did not list its targets");
      const frame = records(listed["targetInfos"]).find(
        (each) => each["type"] === "iframe" && each["url"] === lab.site.url("/entry", "login.example.test"),
      );
      const id = frame?.["targetId"];
      return typeof id === "string" ? await lab.chrome.evaluate(id, expression) : undefined;
    } finally {
      cdp.close();
    }
  }
  const tab = (await lab.chrome.pages()).find(
    (each) => each.title.startsWith(`c-${String(worker.card.id)} `),
  );
  return tab === undefined
    ? undefined
    : lab.chrome.evaluate(tab.id, expression.replaceAll("document.", `${fields}.`)).catch(() => undefined);
}

const fieldIs = (name: string, wanted: string): Promise<void> =>
  until(
    async () =>
      (await inChrome(`document.querySelector("input[name=${name}]")?.value`)) === wanted
        ? true
        : undefined,
    `${name} to hold ${wanted}`,
  ).then(() => undefined);

const PASSWORD_VALUE = 'document.querySelector("input[name=p]").value';

test("a password that the captain types is kept from the worker's eval, screenshots, HTML and copy until the page moves on", async () => {
  await begin(["--captain"]);
  assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '""');

  await clickField(USER);
  await page.keyboard.type("alice");
  await fieldIs("u", "alice");
  assert.equal(
    await worker.act({
      action: "eval",
      expression: 'document.querySelector("input[name=u]").value',
    }),
    '"alice"',
  );

  await clickField(PASSWORD_FIELD);
  await page.keyboard.type(TYPED);
  await fieldIs("p", TYPED);

  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);
  await assert.rejects(worker.act({ action: "eval", expression: "location.pathname" }), ENTERED);
  await assert.rejects(worker.shoot(), ENTERED);
  await assert.rejects(worker.shoot(true), ENTERED);
  await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
  assert.match(await worker.act({ action: "read" }), /entry page/);
  assert.equal(await worker.act({ action: "click", x: 600, y: 400 }), "Clicked 600,400.");

  const target = await tabOf(lab, worker);
  const copied = check(
    BROWSER_OPS["browser.copy"].result,
    await worker.session.call("browser.copy", { target }),
  );
  assert.equal(copied.text, null);
  assert.match(copied.note ?? "", /^nothing was copied: a password entered through the viewer/);
  const framed = check(
    BROWSER_OPS["browser.frame"].result,
    await worker.session.call("browser.frame", { target }),
  );
  assert.equal(framed.image, null);
  assert.match(
    framed.note ?? "",
    /^no picture was returned: a password entered through the viewer/,
  );

  await clickField(REVEAL);
  await until(
    async () =>
      (await inChrome('document.querySelector("input[name=p]").type')) === "text"
        ? true
        : undefined,
    "the password to be shown",
  );
  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);

  await clickField(PASSWORD_FIELD);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await fieldIs("p", "");
  assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '""');
  await page.locator("#capture").evaluate((capture, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    capture.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true }));
  }, TYPED);
  await fieldIs("p", TYPED);
  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);
  await page.keyboard.press("Enter");
  await until(() => (lab.site.posted.length === 1 ? true : undefined), "the form to be submitted");
  assert.deepEqual(lab.site.posted, [{ username: "alice", password: TYPED, code: "" }]);
  const moved = await until(
    () => worker.act({ action: "eval", expression: "location.pathname" }).catch(() => undefined),
    "the page to move on and eval to be allowed again",
  );
  assert.equal(moved, '"/landing"');
  assert.ok((await worker.shoot()).length > 0);
});

test("a captain's middle-button paste protects a fresh form before any viewer keys", async () => {
  await begin(["--captain"]);
  await worker.act({ action: "type", selector: "input[name=u]", text: "alice" });
  await worker.act({
    action: "eval",
    expression: `(() => {
      const field = document.querySelector("input[name=p]");
      for (const name of ["mousedown", "mouseup", "auxclick"]) {
        field.addEventListener(name, (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          if (event.type !== "auxclick") return;
          field.focus();
          document.execCommand("insertText", false, ${JSON.stringify(TYPED)});
        });
      }
    })()`,
  });
  assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '""');
  const point = await pointInPicture(page, size, PASSWORD_FIELD.x, PASSWORD_FIELD.y);
  await page.mouse.click(point.x, point.y, { button: "middle" });
  await fieldIs("p", TYPED);
  await fieldIs("u", "alice");

  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);
  await assert.rejects(worker.shoot(), ENTERED);
  await assert.rejects(worker.shoot(true), ENTERED);
  await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
  const target = await tabOf(lab, worker);
  const copied = check(
    BROWSER_OPS["browser.copy"].result,
    await worker.session.call("browser.copy", { target }),
  );
  assert.equal(copied.text, null);
  assert.match(copied.note ?? "", ENTERED);
  const framed = check(
    BROWSER_OPS["browser.frame"].result,
    await worker.session.call("browser.frame", { target }),
  );
  assert.equal(framed.image, null);
  assert.match(framed.note ?? "", ENTERED);
  await worker.act({ action: "open", url: lab.site.url("/a") });
  assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/a"');
});

test("a gated middle click neither pastes nor marks a worker-filled password", async () => {
  await begin([]);
  await worker.act({ action: "type", selector: "input[name=p]", text: "worker-known" });
  const target = await tabOf(lab, worker);
  const response = await page.request.post(new URL("/api/input", page.url()).href, {
    data: ["down", "up"].map((action) => ({
      target,
      kind: "mouse",
      action,
      ...PASSWORD_FIELD,
      button: "middle",
      buttons: action === "down" ? 4 : 0,
      clickCount: 1,
      modifiers: 0,
    })),
  });
  assert.equal(response.status(), 204);
  assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '"worker-known"');
  assert.ok((await worker.shoot()).length > 0);
});

test("a password that the worker typed itself, or that the captain has not touched, does not restrict it", async () => {
  await begin(["--captain"]);
  await worker.act({ action: "type", selector: "input[name=p]", text: "worker-typed" });
  assert.equal(await worker.act({ action: "eval", expression: PASSWORD_VALUE }), '"worker-typed"');
  assert.ok((await worker.shoot()).length > 0);

  const other = await lab.worker("Users read words");
  await other.act({ action: "open", url: lab.site.url("/words") });
  assert.equal(
    await other.act({ action: "eval", expression: 'document.getElementById("vaulted").value' }),
    '"inner-password"',
  );
});

test("a gated viewer marks the tab too, hides its picture while the password is in the form, and shows it again after the page moves on", async () => {
  await begin([]);
  await clickField(PASSWORD_FIELD);
  await page.keyboard.type(TYPED);
  await fieldIs("p", TYPED);

  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);
  await until(
    async () =>
      ((await page.locator("#note").textContent()) ?? "").includes(
        "a password entered through the viewer is still in this page's form",
      )
        ? true
        : undefined,
    "the picture to be hidden",
  );
  assert.equal(await page.locator("#screen").isHidden(), true);

  await worker.act({ action: "open", url: lab.site.url("/a") });
  await until(
    async () => ((await page.locator("#live").textContent()) === "live" ? true : undefined),
    "the picture to come back",
  );
  assert.equal(await page.locator("#note").isHidden(), true);
  assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/a"');
});

for (const embedding of ["closed-shadow", "cross-frame"]) {
  for (const flags of [["--captain"], []]) {
    test(`${flags.length === 0 ? "gated" : "captain"} reveal before typing in a ${embedding} preserves password protection`, async () => {
      await begin(flags, embedding);
      if (embedding === "closed-shadow") {
        assert.equal(
          await worker.act({ action: "eval", expression: 'document.getElementById("host").shadowRoot === null' }),
          "true",
        );
      }
      await clickField(REVEAL);
      await until(
        async () => (await inChrome('document.querySelector("input[name=p]").type')) === "text" ? true : undefined,
        "the empty password to be revealed before typing",
      );
      assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/entry"');
      assert.ok((await worker.shoot()).length > 0);
      await clickField(PASSWORD_FIELD);
      await page.keyboard.type(TYPED);
      await fieldIs("p", TYPED);
      await assert.rejects(worker.act({ action: "eval", expression: "location.pathname" }), ENTERED);
      await assert.rejects(worker.shoot(), ENTERED);
      await assert.rejects(worker.shoot(true), ENTERED);
      await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
      const target = await tabOf(lab, worker);
      const copied = check(
        BROWSER_OPS["browser.copy"].result,
        await worker.session.call("browser.copy", { target }),
      );
      assert.equal(copied.text, null);
      assert.match(copied.note ?? "", ENTERED);
      const framed = check(
        BROWSER_OPS["browser.frame"].result,
        await worker.session.call("browser.frame", { target }),
      );
      assert.equal(framed.image, null);
      assert.match(framed.note ?? "", ENTERED);
      await worker.act({ action: "click", ...PASSWORD_FIELD });
      await page.locator("#capture").focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await fieldIs("p", "");
      assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/entry"');
      assert.ok((await worker.shoot()).length > 0);
      await worker.act({ action: "read", html: true });
    });
  }
}

test("a reveal click is not dispatched when provenance cannot be established", async () => {
  await begin(["--captain"]);
  await lab.cardd.stop();
  const refused = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/input") return false;
    const sent: unknown = JSON.parse(response.request().postData() ?? "null");
    return (Array.isArray(sent) ? sent : [sent]).some(
      (input: unknown) => isRecord(input) && input["kind"] === "mouse" && input["action"] === "up",
    );
  });
  await clickField(REVEAL);
  assert.equal((await refused).status(), 502);
  await until(
    async () => (await page.getByRole("alert").isVisible()) &&
      ((await page.getByRole("alert").textContent()) ?? "").startsWith("Input failed:") ? true : undefined,
    "a visible input failure instead of a silently discarded click",
  );
  assert.equal(await inChrome('document.querySelector("input[name=p]").type'), "password");
});

for (const embedding of ["frame", "shadow", "cross-frame"]) {
  for (const flags of [["--captain"], []]) {
    test(`${flags.length === 0 ? "gated" : "captain"} passwords in a ${embedding} stay protected after reveal without autocomplete`, async () => {
      await begin(flags, embedding);
      await worker.act({
        action: "eval",
        expression: `(() => {
          window.__fleetPasswordHeld = () => false;
          window.__fleetPasswords = { scan: () => false };
        })()`,
      });
      await clickField(PASSWORD_FIELD);
      await page.keyboard.type(TYPED);
      await fieldIs("p", TYPED);
      await assert.rejects(worker.act({ action: "eval", expression: `${fields}.querySelector("input[name=p]").value` }), ENTERED);
      await worker.act({ action: "click", x: REVEAL.x, y: REVEAL.y });
      assert.equal(await inChrome('document.querySelector("input[name=p]").type'), "text");
      await assert.rejects(worker.act({ action: "eval", expression: "location.pathname" }), ENTERED);
      await assert.rejects(worker.shoot(), ENTERED);
      await assert.rejects(worker.shoot(true), ENTERED);
      await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
      const target = await tabOf(lab, worker);
      const copied = check(BROWSER_OPS["browser.copy"].result, await worker.session.call("browser.copy", { target }));
      assert.equal(copied.text, null);
      assert.match(copied.note ?? "", ENTERED);
      const framed = check(BROWSER_OPS["browser.frame"].result, await worker.session.call("browser.frame", { target }));
      assert.equal(framed.image, null);
      assert.match(framed.note ?? "", ENTERED);
      await worker.act({ action: "click", x: PASSWORD_FIELD.x, y: PASSWORD_FIELD.y });
      await page.locator("#capture").focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await fieldIs("p", "");
      assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/entry"');
      assert.ok((await worker.shoot()).length > 0);
      const cleared = check(BROWSER_OPS["browser.frame"].result, await worker.session.call("browser.frame", { target }));
      assert.equal(cleared.note, null);
      assert.ok(cleared.image !== null);
      await worker.act({ action: "read", html: true });
      await worker.act({ action: "open", url: lab.site.url("/a") });
      assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/a"');
    });
  }
}

test("surviving manual passwords stay protected after restart, open and Back with TOTP disabled", async () => {
  await begin(["--captain"]);
  await clickField(PASSWORD_FIELD);
  await page.keyboard.type(TYPED);
  await fieldIs("p", TYPED);
  await worker.act({ action: "click", x: REVEAL.x, y: REVEAL.y });
  assert.equal(await inChrome('document.querySelector("input[name=p]").type'), "text");
  const before = worker;
  await lab.cardd.restart();
  worker = await lab.reconnect(before);
  await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), /credential|password entered/);
  await worker.act({ action: "open", url: lab.site.url("/a") });
  assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/a"');
  await worker.act({ action: "back" });
  await fieldIs("p", TYPED);
  await assert.rejects(worker.act({ action: "eval", expression: PASSWORD_VALUE }), ENTERED);
  await assert.rejects(worker.act({ action: "read", html: true }), ENTERED);
  await assert.rejects(worker.shoot(), ENTERED);
  const target = await tabOf(lab, worker);
  const copied = check(BROWSER_OPS["browser.copy"].result, await worker.session.call("browser.copy", { target }));
  assert.equal(copied.text, null);
  assert.match(copied.note ?? "", ENTERED);
  await worker.act({ action: "forward" });
  assert.equal(await worker.act({ action: "eval", expression: "location.pathname" }), '"/a"');
});
