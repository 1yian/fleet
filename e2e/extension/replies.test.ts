import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CardSchema, CardViewSchema, check, OPS, type BoardCard, type Card } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const LATER = new Date(Date.now() + 86_400_000).toISOString();

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let mainToken: string;
let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});
beforeEach(async () => {
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.005" }, ["--board", BOARD]);
  cardd.addProject("web", { maverick: "/clones/web" });
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, mainToken);
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

type Move =
  | { readonly text: string }
  | { readonly tool: string; readonly args: Readonly<Record<string, string | number | boolean>> };

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const heard = (agent: string, pattern: RegExp): string[] =>
  [
    ...new Set(
      h
        .callsOf(agent)
        .flat()
        .filter((turn) => turn.role === "user" && pattern.test(turn.text))
        .map((turn) => turn.text),
    ),
  ].sort();

const hears = (agent: string, pattern: RegExp, count = 1): Promise<string[]> =>
  until(() => {
    const found = heard(agent, pattern);
    return found.length >= count ? found : undefined;
  }, `${agent} to hear ${pattern.source}`);

type Act = (said: string) => Move | undefined;

function script(agent: string, act: Act, onResult: Act = () => undefined): void {
  for (let n = 0; n < 200; n += 1)
    h.onModel((turns) => {
      const last: Turn | undefined = turns.at(-1);
      if (last?.role === "user") return act(last.text) ?? { text: "noted" };
      return onResult(last?.text ?? "") ?? { text: "ok" };
    }, agent);
}

const idIn = (text: string): string | undefined => /replyTo="(r-\d+)"/.exec(text)?.[1];

async function asMain(op: string, args: unknown): Promise<unknown> {
  const { status, body } = await cardd.post(mainToken, op, args);
  assert.equal(status, 200, JSON.stringify(body));
  return Reflect.get(Object(body), "value");
}

async function onBoard(card: Card): Promise<BoardCard> {
  const found = (await cardd.board()).cards.find((each) => each.id === card.id);
  if (found === undefined) throw new Error(`c-${String(card.id)} is not on the board`);
  return found;
}

async function resends(card: Card, id: string, count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const thread = check(CardViewSchema, await asMain("card", { card: card.id }));
    const reminders = thread.entries.filter(
      (entry) => entry.fields["condition"] === "reply-resent" && entry.fields["reply"] === id,
    );
    if (reminders.length >= count) return;
    assert.ok(Date.now() < deadline, `waiting for ${id} to be resent ${String(count)} times`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function mainWithCard(name: string): Promise<Card> {
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const card = check(
    CardSchema,
    await asMain("card.new", { title: name, name, kind: "ship", project: "web" }),
  );
  const begun = await asMain("attempt.begin", { card: card.id, host: "maverick", task: "Build" });
  const { token } = check(OPS["attempt.begin"].result, begun);
  h.startPi("c-1-a1", { FLEET_URL: cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" }, [
    EXTENSION,
  ]);
  await hears("default", /^\[fleet\] main on c-1 /);
  return card;
}

const pausing = (text: string, replyTo?: string): Move => ({
  tool: "report",
  args: { status: "paused", text, until: LATER, ...(replyTo === undefined ? {} : { replyTo }) },
});

test("a silent worker is sent the reply again every five minutes, its mate is never told, and the reply stays open", async () => {
  script("default", () => pausing("still building"));
  script("mate", () => undefined);
  const card = await mainWithCard("dev-port");

  await asMain("comment", {
    card: card.id,
    text: "Which port does the dev server use?",
    reply: true,
  });
  const [asked] = await hears("default", /reply owed/);
  const id = idIn(asked ?? "") ?? "";
  assert.equal(
    asked,
    `[fleet] main on c-1 dev-port: Which port does the dev server use? (reply owed, ${id}: answer with report(status, text, replyTo="${id}"))`,
  );
  assert.deepEqual(await hears("default", /still owed/), [
    `[fleet] check on c-1 dev-port (finding): reply ${id} is still owed to main: "Which port does the dev server use?". Please answer with report(status, text, replyTo="${id}").`,
  ]);
  await resends(card, id, 3);
  const entries = check(CardViewSchema, await asMain("card", { card: card.id })).entries;
  const times = entries
    .filter((entry) => entry.fields["reply"] === id && entry.fields["condition"] === "reply-resent")
    .map((entry) => entry.createdAt);
  const gap = (times[2] ?? 0) - (times[1] ?? 0);
  assert.ok(
    gap >= 1500 && gap < 1800,
    `five-minute resend cadence scaled to 1500 ms: ${String(gap)} ms`,
  );
  assert.deepEqual(heard("mate", /unanswered/), []);
  assert.deepEqual(heard("mate", /paused: still building/), [
    "[fleet] c-1 dev-port paused: still building",
  ]);
  const open = (await onBoard(card)).replies;
  assert.deepEqual(
    open.map((each) => [each.id, each.from, each.owes, each.resentAt !== null]),
    [[id, "main", "c-1-a1", true]],
  );
});

test("a correlated report answers the reply and stops its nudges, and a wrong id is refused", async () => {
  let owed = "";
  script(
    "default",
    (said) => {
      if (!said.includes("Which port")) return pausing("still building");
      owed = idIn(said) ?? owed;
      return pausing("port 5173", "r-999");
    },
    (result) => (result.includes("r-999") ? pausing("port 5173", owed) : undefined),
  );
  const card = await mainWithCard("dev-port");

  await asMain("comment", {
    card: card.id,
    text: "Which port does the dev server use?",
    reply: true,
  });
  const [asked] = await hears("default", /reply owed/);
  const id = idIn(asked ?? "") ?? "";
  assert.deepEqual(await hears("mate", /\(replies r-/), [
    `[fleet] c-1 dev-port paused: port 5173 (replies ${id})`,
  ]);
  const refused = h
    .callsOf("default")
    .flat()
    .find((turn) => turn.role === "toolResult" && turn.text.includes("r-999"))?.text;
  assert.equal(refused, "r-999 is not a reply asked on c-1");
  assert.deepEqual((await onBoard(card)).replies, []);

  await asMain("comment", { card: card.id, text: "Which branch is it on?", reply: true });
  await hears("default", /still owed.*Which branch/);
  assert.deepEqual(heard("default", new RegExp(`${id} is still owed`)), []);
  assert.deepEqual(heard("mate", new RegExp(`${id} unanswered`)), []);
});

async function mainWithCleo(): Promise<{ lane: Card; ads: Card }> {
  const cleoToken = cardd.addLane("cleo", "main");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  h.startPi("cleo", { FLEET_URL: cardd.url, FLEET_TOKEN: cleoToken, FLEET_ROLE: "mate" }, [
    EXTENSION,
  ]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "cleo to join the fleet");
  const lane = check(CardSchema, await asMain("comment", { lane: "cleo", text: "Welcome" }));
  await hears("default", /^\[fleet\] main on c-1 cleo: Welcome$/);
  const made = await cardd.post(cleoToken, "card.new", {
    title: "Ads stay under budget",
    name: "ads-budget",
    kind: "scout",
  });
  const ads = check(CardSchema, Reflect.get(Object(made.body), "value"));
  return { lane, ads };
}

test("a silent second mate gets repeated resends on its lane card without an escalation", async () => {
  script("default", () => undefined);
  const { lane } = await mainWithCleo();

  await asMain("comment", { lane: "cleo", text: "Is the ads report ready?", reply: true });
  const [asked] = await hears("default", /reply owed/);
  const id = idIn(asked ?? "") ?? "";
  assert.equal(
    asked,
    `[fleet] main on c-1 cleo: Is the ads report ready? (reply owed, ${id}: answer with comment(card=1, text, replyTo="${id}") or hold(card=1, question, replyTo="${id}"))`,
  );
  assert.deepEqual(await hears("default", /still owed/), [
    `[fleet] check on c-1 cleo (finding): reply ${id} is still owed to main: "Is the ads report ready?". Please answer with comment(card=1, text, replyTo="${id}") or hold(card=1, question, replyTo="${id}").`,
  ]);
  await resends(lane, id, 3);
  assert.deepEqual(heard("mate", /unanswered/), []);
  assert.deepEqual(
    (await onBoard(lane)).replies.map((each) => [each.id, each.from, each.owes]),
    [[id, "main", "cleo"]],
  );

  await asMain("comment", { lane: "cleo", text: "Never mind, I found it", withdraws: id });
  assert.deepEqual((await onBoard(lane)).replies, []);
});

test("a second mate's uncorrelated comment leaves the reply open, and its correlated hold answers it", async () => {
  script("default", (said) => {
    const id = idIn(said);
    if (said.includes("reply owed") && said.includes("budget"))
      return { tool: "comment", args: { lane: "cleo", text: "Looking into the budget" } };
    if (said.includes("still owed") && said.includes("budget") && id !== undefined)
      return {
        tool: "hold",
        args: { card: 2, question: "Raise the budget to $500?", replyTo: id },
      };
    return undefined;
  });
  const { lane, ads } = await mainWithCleo();

  await asMain("comment", { card: ads.id, text: "Should we raise the ads budget?", reply: true });
  const [asked] = await hears("default", /reply owed/);
  const id = idIn(asked ?? "") ?? "";
  await hears("mate", /^\[fleet\] cleo on c-1 cleo: Looking into the budget$/);
  await hears("default", /still owed/);
  assert.deepEqual(await hears("mate", /\(replies r-/), [
    `[fleet] cleo on c-2 ads-budget (hold): Raise the budget to $500? (replies ${id})`,
  ]);
  assert.deepEqual((await onBoard(ads)).replies, []);

  await asMain("comment", { lane: "cleo", text: "Is the ads report ready?", reply: true });
  await hears("default", /still owed.*Is the ads report ready/);
  assert.deepEqual(heard("mate", new RegExp(`${id} unanswered`)), []);
  assert.equal((await onBoard(lane)).replies.length, 1);
});

const boardUrl = (): string => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

async function captainAsks(page: Page, card: number, text: string): Promise<void> {
  await page.goto(`${boardUrl()}#/c-${String(card)}`);
  const box = page.getByRole("textbox", { name: "Comment" });
  await box.fill(text);
  await box.press("Enter");
  await page.getByRole("list", { name: "Thread" }).getByText(text).first().waitFor();
}

test("a captain's board comment owes a reply from main, which is resent and answered on the thread", async () => {
  const page = await browser.newPage();
  script("mate", (said) => {
    const id = idIn(said);
    return said.includes("still owed") && id !== undefined
      ? { tool: "comment", args: { card: 1, text: "Port 5173.", replyTo: id } }
      : undefined;
  });
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const card = check(
    CardSchema,
    await asMain("card.new", { title: "dev-port", name: "dev-port", kind: "scout" }),
  );

  await captainAsks(page, card.id, "Which port does the dev server use?");
  const [asked] = await hears("mate", /reply owed/);
  const id = idIn(asked ?? "") ?? "";
  assert.equal(
    asked,
    `[fleet] captain on c-1 dev-port: Which port does the dev server use? (reply owed by main, ${id}: answer the captain on the board with comment(card=1, text, replyTo="${id}") or hold(card=1, question, replyTo="${id}"))`,
  );
  assert.deepEqual(
    (await onBoard(card)).replies.map((each) => [each.id, each.from, each.owes]),
    [[id, "captain", "main"]],
  );
  await page.getByText("Waiting for a reply").waitFor();

  assert.deepEqual(await hears("mate", /still owed/), [
    `[fleet] check on c-1 dev-port (finding): reply ${id} is still owed to captain: "Which port does the dev server use?". Please answer the captain on the board with comment(card=1, text, replyTo="${id}") or hold(card=1, question, replyTo="${id}").`,
  ]);
  assert.deepEqual(heard("mate", /unanswered/), []);

  const nested = page.locator(".message.captain > .replies > .message");
  await nested.getByText("Port 5173.").waitFor();
  assert.equal(await nested.locator(".name").textContent(), "main");
  const link = nested.getByRole("button", { name: /In reply to your message/ });
  assert.match((await link.textContent()) ?? "", /Which port does the dev server use\?/);
  assert.deepEqual(
    await page
      .locator(".thread > li > header .name, .thread > li > .event-head .name")
      .allTextContents(),
    ["You"],
  );
  assert.equal(await page.getByText("Waiting for a reply").count(), 0);
  assert.deepEqual((await onBoard(card)).replies, []);
  assert.equal(
    (await onBoard(card)).summary,
    "Port 5173.",
    "the board card leads with main's answer to the captain",
  );
  await page.close();
});

test("main relays a second mate's answer to the captain, and the relay stays on the thread", async () => {
  const page = await browser.newPage();
  let captainsId = "";
  script("mate", (said) => {
    const owed = /reply owed by main, (r-\d+)/.exec(said)?.[1];
    if (owed !== undefined) {
      captainsId = owed;
      return { tool: "comment", args: { card: 2, text: "Cleo, is it under budget?", reply: true } };
    }
    return said.includes("(replies r-") && captainsId !== ""
      ? { tool: "comment", args: { card: 2, text: "Yes, under budget.", replyTo: captainsId } }
      : undefined;
  });
  script("default", (said) => {
    const id = /\(reply owed, (r-\d+)/.exec(said)?.[1];
    return id === undefined
      ? undefined
      : { tool: "comment", args: { card: 2, text: "Under budget by $40.", replyTo: id } };
  });
  const { ads } = await mainWithCleo();

  await captainAsks(page, ads.id, "Are the ads under budget?");
  const nested = page.locator(".message.captain > .replies > .message");
  await nested.getByText("Yes, under budget.").waitFor();
  assert.deepEqual(await nested.locator(".name").allTextContents(), ["main"]);
  await nested.getByRole("button", { name: /In reply to your message/ }).waitFor();

  const top = page.locator(".thread > li");
  assert.deepEqual(await top.locator("> header .flow, > .event-head .flow").allInnerTexts(), [
    "You → main",
    "main → cleo",
    "cleo → main",
  ]);
  assert.equal(await page.locator(".thread > .event.quiet").count(), 2);
  await top.getByText("Cleo, is it under budget?").waitFor();
  await top.getByText("Under budget by $40.").waitFor();
  assert.deepEqual((await onBoard(ads)).replies, []);
  await page.close();
});
