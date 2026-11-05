import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chromium, type Browser as Client, type Page } from "playwright";
import { BrowserHerdr, until, type Stream, type Worker } from "../support/browser-herdr.ts";
import { FakeVault } from "../support/fake-vault.ts";
import { formsOf } from "../support/leaks.ts";
import { parseRecord, records, type JsonRecord } from "../support/json.ts";
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

type Colour = "red" | "blue" | "green" | "other";

const TINTS: Readonly<Record<Exclude<Colour, "other">, readonly number[]>> = {
  red: [224, 0, 0],
  blue: [0, 0, 224],
  green: [0, 176, 0],
};

function classify(rgb: readonly number[]): Colour {
  const near = (tint: readonly number[]): boolean =>
    tint.every((channel, at) => Math.abs(channel - (rgb[at] ?? 0)) < 60);
  return (["red", "blue", "green"] as const).find((name) => near(TINTS[name])) ?? "other";
}

async function colourOf(page: Page, data: string): Promise<Colour> {
  const rgb = await page.evaluate(async (jpeg) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${jpeg}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no canvas");
    context.drawImage(image, 0, 0);
    return [...context.getImageData(image.naturalWidth - 10, image.naturalHeight - 10, 1, 1).data];
  }, data);
  return classify(rgb);
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

test("no picture crosses a login or a navigation: each frame belongs to the page state it was taken in, and none shows the login page after the login", async () => {
  vault = new FakeVault([GOOD]);
  fleet = await BrowserHerdr.start({ browser: true, vault });
  const [worker] = await fleet.workers(["Sign in to the portal"]);
  assert.ok(worker !== undefined);
  const portal = fleet.site.url("/tint-portal", "login.example.test");
  assert.equal((await fleet.axi(worker, `open '${portal}'`)).code, 0);
  const address = await fleet.viewerOf(worker.workspace, "gated");
  const watching = await watch(address, await tabId());
  client = await chromium.launch();
  const reader = await client.newPage();
  const seen = new Map<string, Colour>();
  const states = async (): Promise<string[]> => {
    const found: string[] = [];
    for (const message of [...watching.messages]) {
      const data = message["data"];
      if (typeof data !== "string") {
        found.push("hidden");
        continue;
      }
      const known = seen.get(data) ?? (await colourOf(reader, data));
      seen.set(data, known);
      found.push(known);
    }
    return found;
  };
  const reached = (state: Colour) => async (): Promise<true | undefined> =>
    (await states()).includes(state) ? true : undefined;
  await until("a picture of the login page", reached("red"));

  assert.equal((await fleet.axi(worker, "login")).code, 0);
  await until("the viewer to hide the page", async () =>
    (await states()).includes("hidden") ? true : undefined,
  );
  assert.equal((await fleet.axi(worker, "click --selector '#submit'")).code, 0);
  await until("a picture of the page after sign in", reached("blue"));
  const other = fleet.site.url("/tint-other", "login.example.test");
  assert.equal((await fleet.axi(worker, `open '${other}'`)).code, 0);
  await until("a picture of the page that was opened", reached("green"));

  const all = await states();
  const hiddenFrom = all.indexOf("hidden");
  assert.ok(all.slice(0, hiddenFrom).every((state) => state === "red"));
  assert.equal(all.slice(hiddenFrom).includes("red"), false);
  assert.equal(all.slice(all.indexOf("green")).includes("blue"), false);
  assert.equal(all.at(-1), "green");
  assert.equal(leaks(watching.raw), false);
});

test("a summon replaces a gated viewer in main's Browser tab with the captain's, which draws and takes clicks, and an own placement does not replace it back", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker] = await fleet.workers(["Pay the invoice"]);
  assert.ok(worker !== undefined);
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  await fleet.startMain();
  const main = await fleet.mainWorkspace();
  const created = await fleet.lab.run([
    "tab",
    "create",
    "--workspace",
    main,
    "--cwd",
    fleet.scratch.root,
    "--label",
    "shell",
    "--no-focus",
  ]);
  const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  const own: Worker = { card: worker.card, token: fleet.mainToken, workspace: main, pane };
  const card = String(worker.card.id);

  const opened = await fleet.axi(own, `open ${fleet.site.url("/a")} --card ${card}`);
  assert.equal(opened.code, 0, opened.text);
  assert.match(String(parseRecord(opened.text.split("\n")[0] ?? "")["view"]), /your own workspace/);
  const gated = await fleet.viewerOf(main, "gated");

  const summoned = await fleet.axi(worker, "read --captain 'the bank asks for a passkey'");
  assert.equal(summoned.code, 0, summoned.text);
  const captain = await fleet.viewerOf(main, "captain");
  assert.notEqual(captain, gated);
  await assert.rejects(fetch(gated, { redirect: "manual" }));
  assert.equal((await fleet.tabLabels(main)).filter((label) => label === "Browser").length, 1);

  const target = await tabId();
  const watching = await watch(captain, target);
  await until("a picture in the captain's viewer", () => watching.messages.find(isFrame));
  assert.equal(await fleet.inputStatus(captain, target, { x: 120, y: 100 }), 204);
  await until("the click to count", async () => {
    const counted = await fleet.axi(worker, "read --selector '#n'");
    return parseRecord(counted.text.split("\n")[0] ?? "")["result"] === "1" ? true : undefined;
  });

  const again = await fleet.axi(own, `open ${fleet.site.url("/b")} --card ${card}`);
  assert.equal(again.code, 0, again.text);
  assert.equal(await fleet.viewerOf(main), captain);
  assert.equal((await fleet.listingOf(captain)).tabs.length, 1);
});
