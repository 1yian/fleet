/// <reference lib="dom" />
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { CardSchema, check, OPS } from "@fleet/protocol";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));

let browser: Browser;
let cardd: Cardd;
let main: Session;
let mainToken: string;
let page: Page;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});
beforeEach(async () => {
  cardd = await Cardd.start({}, ["--board", BOARD]);
  mainToken = cardd.addLane("main");
  main = await cardd.connect(mainToken);
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
  await cardd.stop();
});

const http = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

async function question(title: string, options: string[]): Promise<Card> {
  const card = check(CardSchema, await main.call("card.new", { title, kind: "captain" }));
  await main.call("hold", { card: card.id, question: `${title}?`, options });
  return card;
}

async function shipped(title: string, task = "fix it") {
  cardd.addProject("web", { local: "/clones/web" }, "acme/web");
  const mate = await cardd.connect(cardd.addLane("cleo", "main"));
  const args = { title, kind: "ship", project: "web" };
  const card = check(CardSchema, await mate.call("card.new", args));
  const begin = { card: card.id, host: "local", task };
  const { token } = check(OPS["attempt.begin"].result, await mate.call("attempt.begin", begin));
  return { card, mate, worker: await cardd.connect(token) };
}

test("Needs you shows a hold, and one click answers it", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await page.goto(http());
  await page.getByText("Pick the API version?").waitFor();

  await page.getByRole("button", { name: "v2" }).click();
  await page.getByText("Nothing waits on you.").waitFor();
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.deepEqual([answer.author, answer.body], ["captain", "v2"]);
});

test("number keys with a modifier do not answer", async () => {
  await question("Ship on Friday", ["yes", "no"]);
  await page.goto(http());
  await page.getByText("Ship on Friday?").waitFor();
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Alt+1");
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("2");
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "no");
  assert.equal(main.entries.filter(({ entry }) => entry.kind === "answer").length, 1);
});

test("a number key answers the first question", async () => {
  await question("Ship on Friday", ["yes", "no"]);
  await page.goto(http());
  await page.getByText("Ship on Friday?").waitFor();
  await page.keyboard.press("2");

  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "no");
});

test("a click on a card that changed since the captain looked is refused", async () => {
  await page.routeWebSocket(/\/live$/, () => undefined);
  const card = await question("Renew the certificate", ["now", "later"]);
  await page.goto(http());
  await page.getByText("Renew the certificate?").waitFor();
  await main.call("hold", {
    card: card.id,
    question: "Renew the certificate?",
    until: Date.now() + 3_600_000,
  });

  await page.getByRole("button", { name: "now" }).click();
  await page
    .getByRole("alert")
    .getByText(`c-${String(card.id)} changed since you looked`)
    .waitFor();
  assert.equal(main.entries.filter(({ entry }) => entry.kind === "answer").length, 0);
});

test("the inbox groups the cards: Needs you, Running, and Done", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await main.call("card.new", { title: "Users see one scrollbar", kind: "scout" });
  const done = check(CardSchema, await main.call("card.new", { title: "Ads", kind: "scout" }));
  const text = "Search ads convert best.";
  await main.call("close.finish", { card: done.id, mode: "done", text, archives: [], left: [] });
  await page.goto(http());

  const titles = (group: string) =>
    page.getByRole("region", { name: group }).locator(".task-title").allTextContents();
  await page.getByRole("region", { name: "Done" }).getByText(text).waitFor();
  assert.deepEqual(await titles("Needs you"), ["Pick the API version"]);
  assert.deepEqual(await titles("Running"), ["Users see one scrollbar"]);
  assert.deepEqual(await titles("Done"), ["Ads"]);
});

test("a click on a card opens its detail: properties, the description, and the thread", async () => {
  const card = check(
    CardSchema,
    await main.call("card.new", {
      title: "Pick the API version",
      kind: "captain",
      intent: "Decide which API version ships.",
      spec: "Compare v1 and v2 before the freeze.",
    }),
  );
  await main.call("comment", { card: card.id, text: "Spec: build the v2 endpoint" });
  await main.call("hold", { card: card.id, question: "Ship v2 now?", options: ["yes", "no"] });
  await page.goto(http());
  await page.getByRole("article", { name: "Pick the API version" }).click();

  const detail = page.getByRole("article", { name: "Pick the API version" });
  await detail.getByRole("heading", { name: "Pick the API version", level: 1 }).waitFor();
  assert.equal(new URL(page.url()).hash, `#/c-${String(card.id)}`);
  const properties = detail.getByLabel("Properties");
  await properties.getByText("Waiting for you").waitFor();
  await properties.getByText("main", { exact: true }).waitFor();
  await detail.getByText("Decide which API version ships.").waitFor();
  await detail.getByRole("button", { name: "Spec" }).click();
  await detail.getByText("Compare v1 and v2 before the freeze.").waitFor();
  const thread = detail.getByRole("list", { name: "Thread" });
  await thread.getByText("waiting for your answer above").waitFor();
  await thread.getByText("Spec: build the v2 endpoint").waitFor();
  await detail.getByRole("region", { name: "Waiting for you" }).getByText("Ship v2 now?").waitFor();

  await page.keyboard.press("Escape");
  await page.getByRole("region", { name: "Needs you" }).waitFor();
  assert.equal(new URL(page.url()).hash, "");
});

test("a card's address opens it directly, and a card that does not exist says so", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await page.goto(`${http()}#/c-${String(card.id)}`);
  await page.getByRole("heading", { name: "Pick the API version", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Fleet" }).click();
  await page.getByRole("region", { name: "Needs you" }).waitFor();
  assert.equal(new URL(page.url()).hash, "");

  await page.goto(`${http()}#/c-99`);
  await page.getByText("c-99 is not on the board.").waitFor();
});

test("the thread is the conversation between the owner and its mate, with each author and the mate's decisions", async () => {
  const { card, mate, worker } = await shipped("Users see one scrollbar");
  await worker.call("report", { status: "working", text: "the scrollbar is doubled" });
  await worker.call("report", {
    status: "needs-decision",
    key: "scope",
    text: "Fix R1 only, or R1 and R2?",
  });
  await mate.call("comment", { card: card.id, text: "fix both R1 and R2", resolves: "scope" });
  await mate.call("hold", { card: card.id, question: "Keep the footer?", options: ["yes", "no"] });
  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "Keep the footer? I say yes.",
    options: ["yes", "no"],
  });
  await page.goto(`${http()}#/c-${String(card.id)}`);

  const thread = page.getByRole("list", { name: "Thread" });
  await thread.getByText("waiting for your answer above").waitFor();
  await page.getByRole("button", { name: "yes" }).click();
  const pr = "https://github.com/acme/web/pull/3";
  cardd.gh.setPr(pr, "OPEN", { ci: "pass" });
  cardd.gh.setHead(pr, `c-${String(card.id)}-a1`);
  await worker.call("report", { status: "done", text: "a final note" });
  await thread.getByText("a final note").waitFor();

  const items = await thread.getByRole("listitem").allInnerTexts();
  const lines = items.map((item) => item.replace(/\s+/g, " "));
  assert.match(lines[0] ?? "", /cleo sent the task .*fix it/);
  assert.match(lines[1] ?? "", /Worker .*the scrollbar is doubled/);
  assert.match(lines[2] ?? "", /Worker needs a decision scope .*Fix R1 only, or R1 and R2\?/);
  assert.match(lines[3] ?? "", /cleo Mate decided scope .*fix both R1 and R2/);
  assert.match(lines[4] ?? "", /cleo Mate asked .*Keep the footer\?/);
  assert.match(lines[5] ?? "", /main First mate escalated it .*Keep the footer\? I say yes\./);
  assert.match(lines[6] ?? "", /You answered .*yes/);
  assert.match(lines[7] ?? "", /Worker is done .*a final note/);
  assert.match(lines[8] ?? "", /Fleet asked .*Merge https:\/\/github\.com\/acme\/web\/pull\/3/);
  assert.equal(lines.length, 9);
  await worker.close();
});

test("a long task message is one line that opens to the whole text", async () => {
  const task = ["Fix the scrollbar", "Keep the footer", "Do not touch the header"].join("\n");
  const { card, worker } = await shipped("Users see one scrollbar", task);
  await page.goto(`${http()}#/c-${String(card.id)}`);
  const thread = page.getByRole("list", { name: "Thread" });
  const sent = thread.getByRole("button", { name: /sent the task/ });
  await sent.getByText("Fix the scrollbar").waitFor();
  assert.equal(await thread.getByText("Do not touch the header").count(), 0);

  await sent.click();
  await thread.getByText("Do not touch the header").waitFor();
  await sent.click();
  await thread.getByText("Do not touch the header").waitFor({ state: "detached" });
  await worker.close();
});

test("a long message collapses, and Show more opens it", async () => {
  const { card, worker } = await shipped("Users see one scrollbar");
  const lines = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`);
  await worker.call("report", { status: "working", text: lines.join("\n") });
  await page.goto(`${http()}#/c-${String(card.id)}`);
  const thread = page.getByRole("list", { name: "Thread" });
  const body = thread.locator(".body");
  await thread.getByText("line 1", { exact: false }).first().waitFor();
  const short = (await body.boundingBox())?.height ?? 0;
  assert.ok(short > 0 && short < 300, `collapsed to ${String(short)} px`);

  await thread.getByRole("button", { name: "Show more" }).click();
  await thread.getByRole("button", { name: "Show less" }).waitFor();
  assert.ok(((await body.boundingBox())?.height ?? 0) > 500);
  await worker.close();
});

test("the captain chats on a card: Enter sends to the card's mate, Shift+Enter starts a new line", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const card = check(CardSchema, await cleo.call("card.new", { title: "Ads", kind: "scout" }));
  await page.goto(`${http()}#/c-${String(card.id)}`);
  const composer = page.getByRole("textbox", { name: "Comment" });
  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("second line");
  assert.equal(cleo.entries.length, 0);
  await composer.press("Enter");

  const comment = await cleo.waitForEntry((entry) => entry.kind === "comment", "the comment");
  assert.deepEqual([comment.author, comment.body], ["captain", "first line\nsecond line"]);
  assert.equal(main.entries.filter(({ entry }) => entry.kind === "comment").length, 0);
  const thread = page.getByRole("list", { name: "Thread" });
  await thread.getByText("second line").waitFor();
  assert.equal(await composer.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
});

test("a draft survives a new entry on the open card, and stays with its own card", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  const other = await question("Renew the certificate", ["now", "later"]);
  await page.goto(`${http()}#/c-${String(card.id)}`);
  const composer = page.getByRole("textbox", { name: "Comment" });
  await composer.fill("I prefer v2 because");

  await main.call("hold", { card: card.id, question: "Ship on Friday?", options: ["yes", "no"] });
  await page
    .getByRole("region", { name: "Waiting for you" })
    .getByText("Ship on Friday?")
    .waitFor();
  assert.equal(await composer.inputValue(), "I prefer v2 because");

  await page.goto(`${http()}#/c-${String(other.id)}`);
  assert.equal(await page.getByRole("textbox", { name: "Comment" }).inputValue(), "");
});

test("a refused message comes back into the composer", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await page.route("**/api/action", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "the card changed since you looked" }),
    }),
  );
  await page.goto(`${http()}#/c-${String(card.id)}`);
  const composer = page.getByRole("textbox", { name: "Comment" });
  await composer.fill("I prefer v2 because");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await page.getByRole("alert").getByText("the card changed since you looked").waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).isEnabled();
  assert.equal(await composer.inputValue(), "I prefer v2 because");
});

test("Write your own answers the question in the captain's words, for the card's mate", async () => {
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const card = check(CardSchema, await cleo.call("card.new", { title: "Ads", kind: "scout" }));
  await cleo.call("hold", { card: card.id, question: "Which channel?", options: ["search"] });
  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "Which channel?",
    options: ["search"],
  });
  await page.goto(http());
  await page.getByText("Which channel?").waitFor();

  await page.getByRole("button", { name: "Write your own" }).click();
  const box = page.getByRole("textbox", { name: "Your answer" });
  await box.fill("Neither: try podcasts");
  await box.press("Shift+Enter");
  await box.pressSequentially("and newsletters");
  await box.press("Enter");

  const answer = await cleo.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.deepEqual(
    [answer.author, answer.body],
    ["captain", "Neither: try podcasts\nand newsletters"],
  );
  assert.equal(answer.fields["source"], "board");
  assert.equal(answer.fields["written"], true);
  await page.getByText("Nothing waits on you.").waitFor();
});

test("Escape closes the answer box and not the card", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  await page.goto(`${http()}#/c-${String(card.id)}`);
  await page.getByRole("button", { name: "Write your own" }).click();
  await page.getByRole("textbox", { name: "Your answer" }).press("Escape");
  await page.getByRole("button", { name: "Write your own" }).waitFor();
  assert.equal(new URL(page.url()).hash, `#/c-${String(card.id)}`);
  await page.keyboard.press("Escape");
  await page.getByRole("region", { name: "Needs you" }).waitFor();
});

test("the board reloads after its live socket reconnects", async () => {
  await page.goto(http());
  await page.getByText("Nothing waits on you.").waitFor();

  await cardd.restart();
  main = await cardd.connect(mainToken);
  await question("Renew the certificate", ["now", "later"]);
  await page.getByText("Renew the certificate?").waitFor();
});

test("a board load that finishes late does not replace a newer one", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  let calls = 0;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/board", async (route) => {
    calls += 1;
    if (calls > 1) {
      await route.continue();
      return;
    }
    const stale = await route.fetch();
    await held;
    await route.fulfill({ response: stale });
  });
  await page.goto(http());
  await page.getByText("Pick the API version?").waitFor();

  await question("Renew the certificate", ["now", "later"]);
  await page.getByText("Renew the certificate?").waitFor();
  release();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.getByText("Renew the certificate?").isVisible(), true);
});

test("a request that cannot reach cardd shows a notice, and a refused reply stays in the box", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  await page.route("**/api/action", (route) => route.abort());
  await page.goto(http());
  await page.getByText("Pick the API version?").waitFor();
  await page.getByRole("button", { name: "v1" }).click();
  await page
    .getByRole("alert")
    .getByText(/The board could not reach cardd/)
    .waitFor();

  await page.getByRole("link", { name: /Pick the API version/ }).click();
  const composer = page.getByRole("textbox", { name: "Comment" });
  await composer.fill("I prefer v2 because");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText(/The board could not reach cardd/)
    .waitFor();
  assert.equal(await composer.inputValue(), "I prefer v2 because");
});

test("a board load that cannot reach cardd shows a notice that goes away when loading works", async () => {
  await question("Pick the API version", ["v1", "v2"]);
  let blocked = true;
  await page.route("**/api/board", (route) => (blocked ? route.abort() : route.continue()));
  await page.goto(http());
  await page
    .getByRole("alert")
    .getByText(/The board could not reach cardd/)
    .waitFor();

  blocked = false;
  await main.call("comment", { card: 1, text: "wake the board" });
  await page.getByText("Pick the API version?").waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
});

const sideways = (target: Page): Promise<string[]> =>
  target.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll("body *")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .filter((element) => !["hidden", "clip"].includes(getComputedStyle(element).overflowX))
      .map((element) => element.className || element.tagName),
  );

test("nothing scrolls sideways, on a desktop or a phone, even with long unbroken text", async () => {
  const card = await question("Pick the API version", ["v1", "v2"]);
  const url = `https://example.com/${"a".repeat(240)}`;
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 800 },
  ]) {
    await main.call("hold", { card: card.id, question: `Evidence:\n${url}`, options: ["ok"] });
    await page.setViewportSize(viewport);
    await page.goto(http());
    await page
      .getByText(/Evidence:/)
      .first()
      .waitFor();
    assert.deepEqual(await sideways(page), [], `the board at ${String(viewport.width)} px`);

    await page.getByRole("link", { name: /Pick the API version/ }).click();
    await page.getByRole("region", { name: "Waiting for you" }).getByText(url).waitFor();
    await page.getByRole("button", { name: "Write your own" }).first().click();
    await page.getByRole("textbox", { name: "Your answer" }).fill(url);
    await page.getByRole("textbox", { name: "Comment" }).fill(url);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("list", { name: "Thread" }).getByText(url).last().waitFor();
    assert.deepEqual(await sideways(page), [], `the card at ${String(viewport.width)} px`);
    const box = await page.getByRole("textbox", { name: "Comment" }).boundingBox();
    assert.ok(box !== null && box.y + box.height <= viewport.height, "the composer is on screen");
  }
});

test("long options show as a list of full-width choices, and one click answers", async () => {
  const long = "Same, but main's comment goes straight to the lane's worker";
  await question("Pick the messaging", [
    "Recommended: main's comment goes to the lane's mate",
    long,
    "Hold off",
  ]);
  await page.goto(http());
  const short = page.getByRole("button", { name: "Hold off" });
  const box = await short.boundingBox();
  const row = await short.locator("..").boundingBox();
  assert.ok(
    box !== null && row !== null && Math.abs(box.width - row.width) < 1,
    "a choice fills its row",
  );

  await page.getByRole("button", { name: long }).click();
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, long);
});
