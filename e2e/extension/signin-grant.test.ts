import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { FakeBrowser } from "../support/fake-browser.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const MARKER = "Zq7-marker-PASSWORD-91x";
const SIGN_IN = "https://login.example.test/session/new";
const USER = "cleo@example.test";

let fleet: Fleet;
let h: Harness;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  card = await newCard(fleet.main, "Sign in to the vendor site");
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

async function captainSays(text: string): Promise<number> {
  const before = (await fleet.cardd.thread(card.id)).entries.length;
  assert.equal(await fleet.cardd.act(card.id, { kind: "comment", text }), 200);
  const entries = (await fleet.cardd.thread(card.id)).entries;
  assert.equal(entries.length, before + 1);
  const entry = entries.at(-1);
  assert.ok(entry);
  return entry.id;
}

async function grant(
  entry: number,
  extra: { lane?: string; url?: string; span?: { start: number; end: number } } = {},
): Promise<string> {
  const { status, body } = await fleet.cardd.refusal(card.id, {
    kind: "signin-grant",
    entry,
    lane: "main",
    url: SIGN_IN,
    username: USER,
    ...extra,
  });
  assert.equal(status, 200);
  const ref = typeof body === "object" && body !== null ? Reflect.get(body, "grant") : undefined;
  assert.equal(typeof ref, "string");
  return String(ref);
}

const REFUSED = "no sign-in grant matches this request, or it was already used";

function everyFile(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isFile());
}

function assertMarkerOnlyInTheEntry(browser: FakeBrowser): void {
  const sources = [
    ...h.calls.flat().map((turn) => turn.text),
    JSON.stringify(h.wire),
    fleet.cardd.output,
    fleet.cardd.errors,
    ...everyFile(h.dir).map((path) => readFileSync(path, "latin1")),
    ...everyFile(browser.dir).map((path) => readFileSync(path, "latin1")),
  ];
  for (const source of sources) assert.ok(!source.includes(MARKER));
}

async function redeem(
  browser: FakeBrowser,
  calls: readonly Record<string, string | number>[],
): Promise<string[]> {
  for (const args of calls) h.onModel(() => ({ tool: "browser_signin", args }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "finished" } }));
  const token = await begin(fleet.main, card, "sign in");
  const env = {
    ...browser.env,
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
  };
  h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
  await fleet.main.waitForEntry((entry) => entry.kind === "report", "the worker's report");
  const results = toolResults(await h.waitForCall(calls.length));
  assertMarkerOnlyInTheEntry(browser);
  return results;
}

test("the captain's grant signs the lane's browser in without the worker seeing the password", async () => {
  const entry = await captainSays(MARKER);
  const ref = await grant(entry);
  const announcement = (await fleet.cardd.thread(card.id)).entries.at(-1);
  assert.match(
    announcement?.body ?? "",
    new RegExp(`^Sign-in grant ${ref}: one use, for lane main`),
  );
  const browser = new FakeBrowser();

  const results = await redeem(browser, [{ grant: ref, entry, url: SIGN_IN }]);

  assert.equal(results.length, 1);
  assert.match(results[0] ?? "", /^browser_signin done\. /);
  const [call, ...more] = browser.calls();
  assert.equal(more.length, 0);
  assert.deepEqual(call?.["argv"], ["login", "--lane", "main", "--stdin"]);
  assert.equal(call?.["stdinIsTty"], false);
  assert.deepEqual(call?.["keys"], ["lane", "origin", "password", "url", "username"]);
  assert.equal(call?.["origin"], "https://login.example.test");
  assert.equal(call?.["url"], SIGN_IN);
  assert.equal(call?.["username"], USER);
  assert.equal(call?.["passwordSha256"], sha(MARKER));
  const others = (await fleet.cardd.thread(card.id)).entries.filter((each) => each.id !== entry);
  assert.ok(!JSON.stringify(others).includes(MARKER));
});

test("a captain-selected span, not the whole entry, is the password", async () => {
  const entry = await captainSays(`The vendor login is ${MARKER} - do not share`);
  const start = `The vendor login is `.length;
  const ref = await grant(entry, { span: { start, end: start + MARKER.length } });
  const browser = new FakeBrowser();

  const results = await redeem(browser, [{ grant: ref, entry, url: SIGN_IN }]);

  assert.match(results[0] ?? "", /^browser_signin done\. /);
  assert.equal(browser.calls()[0]?.["passwordSha256"], sha(MARKER));
});

test("a grant is refused for another lane, entry, or site, and a refusal does not spend it", async () => {
  fleet.cardd.addLane("cleo", "main");
  const entry = await captainSays(MARKER);
  const other = await captainSays("a different entry");
  const forCleo = await grant(entry, { lane: "cleo" });
  const forMain = await grant(entry);
  const browser = new FakeBrowser();

  const results = await redeem(browser, [
    { grant: forCleo, entry, url: SIGN_IN },
    { grant: forMain, entry: other, url: SIGN_IN },
    { grant: forMain, entry, url: "https://evil.example.test/session/new" },
    { grant: forMain, entry, url: "https://login.example.test:8443/session/new" },
    { grant: forMain, entry, url: "https://login.example.test/other" },
    { grant: forMain, entry, url: SIGN_IN },
  ]);

  assert.deepEqual(
    results.slice(0, 5),
    Array.from({ length: 5 }, () => REFUSED),
  );
  assert.match(results[5] ?? "", /^browser_signin done\. /);
  assert.equal(browser.calls().length, 1);
});

test("a grant works once: a replay is refused and no second sign-in is sent", async () => {
  const entry = await captainSays(MARKER);
  const ref = await grant(entry);
  const browser = new FakeBrowser();

  const results = await redeem(browser, [
    { grant: ref, entry, url: SIGN_IN },
    { grant: ref, entry, url: SIGN_IN },
  ]);

  assert.match(results[0] ?? "", /^browser_signin done\. /);
  assert.equal(results[1], REFUSED);
  assert.equal(browser.calls().length, 1);
});

test("a sign-in the site does not confirm spends the grant, and the worker sees only a fixed outcome", async () => {
  const entry = await captainSays(MARKER);
  const ref = await grant(entry);
  const browser = new FakeBrowser("stuck");

  const results = await redeem(browser, [
    { grant: ref, entry, url: SIGN_IN },
    { grant: ref, entry, url: SIGN_IN },
  ]);

  assert.equal(
    results[0],
    "browser_signin stuck. The sign-in was not confirmed. Check the page before you do anything else. The grant is spent.",
  );
  assert.equal(results[1], REFUSED);
  assert.equal(browser.calls().length, 1);
});

test("the board refuses a grant that does not name a one-line password, an entry of this card, an https URL, or a lane", async () => {
  const prose = await captainSays(`Here you go\n${MARKER}\nthanks`);
  const entry = await captainSays(MARKER);
  const elsewhere = await newCard(fleet.main, "Another card");
  const refuse = async (
    on: Card,
    action: Parameters<typeof fleet.cardd.refusal>[1],
  ): Promise<string | undefined> => {
    const { status, error, body } = await fleet.cardd.refusal(on.id, action);
    assert.equal(status, 400);
    assert.ok(!JSON.stringify(body).includes(MARKER));
    return error;
  };
  const base = { kind: "signin-grant", entry, lane: "main", url: SIGN_IN } as const;

  assert.match((await refuse(card, { ...base, entry: prose })) ?? "", /one-line password/);
  assert.match(
    (await refuse(card, { ...base, span: { start: 0, end: 999 } })) ?? "",
    /one-line password/,
  );
  assert.match((await refuse(elsewhere, base)) ?? "", /there is no entry/);
  assert.match((await refuse(card, { ...base, url: "http://login.example.test/" })) ?? "", /https/);
  assert.match(
    (await refuse(card, { ...base, lane: "nowhere" })) ?? "",
    /there is no lane nowhere/,
  );
  assert.equal(
    (await fleet.cardd.thread(card.id)).entries.filter((each) => /^Sign-in grant/.test(each.body))
      .length,
    0,
  );
});

test("announcing a grant leaves the captain's hold with the captain and owes no reply", async () => {
  const entry = await captainSays(MARKER);
  await fleet.main.call("hold", { card: card.id, question: "Ship it?", options: ["yes", "no"] });
  const before = (await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.status;
  assert.equal(before, "needs-you");

  await grant(entry);

  const announcement = (await fleet.cardd.thread(card.id)).entries.at(-1);
  assert.match(announcement?.body ?? "", /^Sign-in grant sg-/);
  assert.equal(announcement?.fields["owes"], undefined);
  const after = (await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.status;
  assert.equal(after, "needs-you");

  await captainSays("one more thing");
  const taken = (await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.status;
  assert.notEqual(taken, "needs-you");
});
