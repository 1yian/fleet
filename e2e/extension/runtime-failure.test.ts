import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { gate, Harness, type Pi } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const T0 = Date.parse("2026-05-04T09:00:00Z");

let fleet: Fleet;
let h: Harness;
let clockFile: string;
beforeEach(async () => {
  clockFile = join(tempDir("fleet-clock-"), "clock");
  setClock(T0);
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02", CARDD_CLOCK_FILE: clockFile });
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

function setClock(ms: number): void {
  const next = `${clockFile}.next`;
  writeFileSync(next, new Date(ms).toISOString());
  renameSync(next, clockFile);
}

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";
const heardFailures = (mate: Session): Entry[] =>
  mate.entries.map((push) => push.entry).filter(isFailure);
const incidentOf = (entry: Entry): { incident: number; generation: number } => {
  const found = /Incident (\d+), process generation (\d+)/.exec(entry.body);
  return { incident: Number(found?.[1]), generation: Number(found?.[2]) };
};
const recoveries = (mate: Session, card: Card): Entry[] =>
  mate.entries
    .map((push) => push.entry)
    .filter((entry) => entry.card === card.id && /recovered \(|did not verify/.test(entry.body));

async function thread(card: Card, mate = fleet.main): Promise<Entry[]> {
  return check(CardViewSchema, await mate.call("card", { card: card.id })).entries;
}

async function cardsOnBoard(): Promise<[number, string, string][]> {
  return (await fleet.cardd.board()).cards.map((each) => [each.id, each.name, each.title]);
}

async function laterCheck(mate = fleet.main): Promise<void> {
  const witness = await newCard(mate, "a later card");
  await begin(mate, witness);
  await mate.waitForEntry(
    (entry) => entry.card === witness.id && entry.fields["condition"] === "worker-never-connected",
    "a check pass after the failure",
  );
}

async function worker(card: Card, task = "the task"): Promise<Pi> {
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: await begin(fleet.main, card, task),
    FLEET_ROLE: "worker",
  };
  return h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
}

async function actor(card: Card): Promise<Session> {
  return fleet.cardd.connect(await begin(fleet.main, card));
}

const recover = (
  mate: Session,
  heard: Entry,
  mode: string,
  key = `k-${mode}`,
  generation = incidentOf(heard).generation,
): Promise<unknown> =>
  mate.call("incident.recover", { incident: incidentOf(heard).incident, generation, mode, key });

test("a failed worker turn reaches its mate once with the sanitized cause, and no stop, nudge, or reminder follows", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  h.onModel(() => ({
    fail: "provider exploded: code 42 Authorization: Bearer sk-secret1234567890abcdef",
  }));
  await worker(card);
  const heard = await fleet.main.waitForEntry(isFailure, "the failed turn to reach the mate");

  assert.equal(heard.kind, "finding");
  assert.match(
    heard.body,
    /^runtime failure: the worker on c-1 its model turn failed: provider exploded: code 42/,
  );
  assert.ok(!heard.body.includes("sk-secret"), heard.body);
  assert.match(
    heard.body,
    /Classified unknown\. Incident 1, process generation 1\. Recover with recover\(/,
  );

  await laterCheck();
  await fleet.cardd.restart();
  const again = await fleet.cardd.connect(fleet.mainToken);
  await laterCheck(again);
  const thread1 = await thread(card, again);
  assert.equal(thread1.filter(isFailure).length, 1);
  assert.deepEqual(
    thread1.filter((entry) => entry.kind === "finding" && !isFailure(entry)),
    [],
  );
  assert.equal(thread1.filter((entry) => entry.kind === "report").length, 0);
  assert.equal(await status(again, card), "working");
  assert.equal(h.calls.length, 1);
});

test("a failure while paused is reported with the card's intent and cannot be recovered into work", async () => {
  const card = await newCard(fleet.main, "Waiting for the vendor");
  const until = "2099-01-01T00:00:00Z";
  h.onModel(() => ({ tool: "report", args: { status: "paused", text: "waiting", until } }));
  h.onModel(() => ({ fail: "provider exploded: code 7" }));
  await worker(card);
  const heard = await fleet.main.waitForEntry(isFailure, "the failure on a paused card");

  assert.match(
    heard.body,
    /Its card is paused, so recovery is not offered and nothing is resumed\./,
  );
  await assert.rejects(
    recover(fleet.main, heard, "retry"),
    /the card is paused: recovery never resumes it/,
  );
  assert.equal(await status(fleet.main, card), "paused");
});

test("a finished worker whose process then goes away is not reported as a failure", async () => {
  const card = await newCard(fleet.main, "Scout the logs", "scout");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "found it" } }));
  const pi = await worker(card);
  await fleet.main.waitForEntry((entry) => entry.kind === "report", "the done report");
  await pi.kill();
  await laterCheck();

  assert.equal(heardFailures(fleet.main).length, 0);
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a worker process killed with no final event raises one unknown incident that only its mate hears", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const open = gate();
  h.onModel(async () => {
    await open.wait;
    return { text: "never" };
  });
  const pi = await worker(card);
  await h.waitForCall(0);
  await pi.kill();
  const heard = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "worker-not-connected",
    "the lost process to reach the mate",
  );
  open.open();

  assert.equal(heard.fields["condition"], "worker-not-connected");
  assert.match(
    heard.body,
    /^worker not connected\. Incident 1, process generation 1\. Recover with/,
  );
  assert.match(heard.body, /mode=replace\)\.$/);
  await laterCheck();
  assert.equal(fleet.main.entries.filter((push) => push.entry.card === card.id).length, 1);
  await assert.rejects(
    recover(fleet.main, heard, "retry"),
    /retry is not available .* Available: replace/,
  );
  await assert.rejects(recover(fleet.main, heard, "replace", "k", 99), /read the card again/);
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  await assert.rejects(recover(cleo, heard, "replace"), /not yours to recover: only main can/);
});

test("a recovery check on the live process is verified by a real answer and an action, once, and duplicates are refused", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  h.onModel(() => ({ fail: "provider exploded: code 42" }));
  h.onModel(() => ({ tool: "report", args: { status: "note", text: "alive and idle" } }));
  h.onModel(() => ({ text: "recovered, nothing resumed" }));
  await worker(card, "fix the scrollbar");
  const heard = await fleet.main.waitForEntry(isFailure, "the failed turn");

  const cardsBefore = await cardsOnBoard();
  const [first, second] = await Promise.allSettled([
    recover(fleet.main, heard, "retry", "one"),
    recover(fleet.main, heard, "retry", "two"),
  ]);
  const winner = first.status === "fulfilled" ? "one" : "two";
  assert.deepEqual([first.status, second.status].sort(), ["fulfilled", "rejected"]);
  const loser = first.status === "rejected" ? first : second;
  assert.match(
    String(loser.status === "rejected" ? loser.reason : ""),
    /already has a recovery in progress/,
  );
  await recover(fleet.main, heard, "retry", winner);

  const done = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "recovery to verify",
  );
  assert.match(done.body, /answered the recovery check and acted/);
  assert.doesNotMatch(done.body, /compact/);
  const probe = (await h.waitForCall(1)).findLast((turn) => turn.role === "user")?.text ?? "";
  assert.match(
    probe,
    /^\[fleet\] main on c-1 users-see-one-scrollbar: recovery check 1 from main: this is a health check, not new work\./,
  );
  assert.ok((await h.waitForCall(1)).some((turn) => turn.text.includes("fix the scrollbar")));
  const notes = (await thread(card)).filter((entry) => entry.fields["status"] === "note");
  assert.deepEqual(
    notes.map((entry) => entry.body),
    ["alive and idle"],
  );
  assert.deepEqual(await cardsOnBoard(), cardsBefore);
  assert.ok((await thread(card)).filter(isFailure).length >= 2);
  await laterCheck();
  assert.equal(recoveries(fleet.main, card).length, 1);
  await assert.rejects(
    recover(fleet.main, heard, "retry", "three"),
    /is verified: there is nothing to recover/,
  );
});

test("a recovery check that fails again is reported once per attempt, and the budget ends in a block", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  for (const error of ["first", "second", "third"])
    h.onModel(() => ({ fail: `provider exploded: ${error}` }));
  await worker(card);
  const heard = await fleet.main.waitForEntry(isFailure, "the failed turn");

  await recover(fleet.main, heard, "retry", "a");
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes("did not verify: provider exploded: second"),
    "the first retry to fail",
  );
  await recover(fleet.main, heard, "retry", "b");
  const spent = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("did not verify: provider exploded: third"),
    "the second retry to fail",
  );

  assert.match(spent.body, /Recover with recover\(incident=1, generation=1, mode=replace\)/);
  await assert.rejects(
    recover(fleet.main, heard, "retry", "c"),
    /retry is not available .* Available: replace/,
  );
  assert.equal(h.calls.length, 3);
});

test("retry-after holds recovery until the controlled time, then exactly one wake says it is due", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker1 = await actor(card);
  await worker1.call("incident.report", { error: "429 Too Many Requests. Retry-After: 120" });
  const heard = await fleet.main.waitForEntry(isFailure, "the rate limit failure");

  assert.match(heard.body, /Classified transient\./);
  assert.match(heard.body, /eligible at 2026-05-04T09:02:00\.000Z\.$/);
  await assert.rejects(
    recover(fleet.main, heard, "retry"),
    /not eligible for recovery until 2026-05-04T09:02:00\.000Z/,
  );
  setClock(T0 + 119_000);
  await laterCheck();
  assert.equal(heardFailures(fleet.main).length, 1);

  setClock(T0 + 121_000);
  await laterCheck();
  const due = fleet.main.entries.filter((push) =>
    push.entry.body.includes("is eligible for recovery now"),
  );
  assert.equal(due.length, 1);
  await laterCheck();
  assert.equal(
    fleet.main.entries.filter((push) => push.entry.body.includes("is eligible for recovery now"))
      .length,
    1,
  );

  await recover(fleet.main, heard, "retry");
  await worker1.waitForEntry(
    (entry) => entry.body.includes("recovery check 1"),
    "the recovery check",
  );
  await worker1.call("report", { status: "note", text: "alive" });
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "verification",
  );
});

test("a local router cooldown, vendor quota, stale module, and bad credentials are told apart", async () => {
  const kinds: [string, string, RegExp][] = [
    [
      "no model is available for tier default: every model is cooling",
      "router-cooldown",
      /mode=retry\), eligible at/,
    ],
    [
      "insufficient_quota: You exceeded your current quota",
      "vendor-quota",
      /Restarting is not a repair for vendor-quota/,
    ],
    [
      "Cannot find module '/old/bundle/index.js' imported from /app/pi.js",
      "stale-module",
      /mode=replace\)\.$/,
    ],
    ["401 invalid api key", "auth", /Restarting is not a repair for auth/],
  ];
  for (const [error, kind, next] of kinds) {
    const card = await newCard(fleet.main, kind);
    const session = await actor(card);
    await session.call("incident.report", { error });
    const heard = await fleet.main.waitForEntry(
      (entry) => isFailure(entry) && entry.card === card.id,
      kind,
    );
    assert.match(heard.body, new RegExp(`Classified ${kind}\\.`));
    assert.match(heard.body, next);
    if (kind === "vendor-quota")
      await assert.rejects(recover(fleet.main, heard, "replace"), /is blocked/);
  }
});

test("a second mate's failure reaches only main, and main's own failure lands on the board with no agent to tell", async () => {
  const cleoToken = fleet.cardd.addLane("cleo", "main");
  h.onModel(() => ({ fail: "provider exploded: code 9" }), "cleo");
  const cleo = h.startPi(
    "cleo",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: cleoToken,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "cleo",
    },
    [EXTENSION],
  );
  cleo.prompt("hello");
  const heard = await fleet.main.waitForEntry(isFailure, "the second mate's failure");
  assert.match(
    heard.body,
    /^runtime failure: cleo its model turn failed: provider exploded: code 9\./,
  );
  assert.match(heard.body, /mode=retry or replace\)/);

  const failing = await fleet.cardd.board();
  for (let call = 0; call < 2; call += 1)
    h.onModel(() => ({ fail: "provider exploded: main" }), "main");
  const main = h.startPi(
    "main",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: fleet.mainToken,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "main",
    },
    [EXTENSION],
  );
  main.prompt("hello");
  await h.waitForCall(0, "main");
  const card = await untilBoard(failing.cards.length);
  assert.equal(card.status, "needs-you");
  const view = await fleet.cardd.thread(card.id);
  assert.match(
    view.entries.map((entry) => entry.body).join("\n"),
    /main its model turn failed: provider exploded: main/,
  );
  assert.equal(heardFailures(fleet.main).length, 1);
});

async function untilBoard(known: number): Promise<{ id: number; status: string }> {
  for (let tries = 0; tries < 500; tries += 1) {
    const cards = (await fleet.cardd.board()).cards;
    const found = cards.find((each) => each.name === "main-runtime-failure");
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `no failure card after ${String(known)} cards: ${JSON.stringify((await fleet.cardd.board()).cards.map((c) => c.name))}`,
  );
}

const COMPACTOR_DOWN = "no model is available for tier default: every model is cooling";
const BIG = "lorem ipsum dolor ".repeat(8000);

async function compactingCleo(compactorUp: () => boolean): Promise<void> {
  const token = fleet.cardd.addLane("cleo", "main");
  for (let call = 0; call < 30; call += 1)
    h.onModel((turns) => {
      if (!turns.some((turn) => turn.text.includes("ONLY output the structured summary")))
        return { text: "ok" };
      return compactorUp() ? { text: "a summary" } : { fail: COMPACTOR_DOWN };
    }, "cleo");
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "mate" };
  const cleo = h.startPi("cleo", { ...env, FLEET_FAKE_AGENT: "cleo" }, [EXTENSION]);
  for (let turn = 1; turn <= 3; turn += 1) {
    cleo.prompt(`${BIG}${String(turn)}`);
    await h.waitForNth((event) => event["type"] === "settled", turn, "the turn to settle");
  }
}

test("a failed compaction is its own incident with the original error, and recovery on the same card is verified only by a successful compaction", async () => {
  let compactorUp = false;
  await compactingCleo(() => compactorUp);
  const heard = await fleet.main.waitForEntry(isFailure, "the compaction failure");
  assert.match(
    heard.body,
    new RegExp(
      `^runtime failure: cleo its conversation compaction failed: Auto-compaction failed: Summarization failed: ${COMPACTOR_DOWN}\\.`,
    ),
  );
  assert.match(heard.body, /Classified router-cooldown\./);
  setClock(T0 + 10_000);
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes("is eligible for recovery now"),
    "the eligible time",
  );
  const cardsBefore = await cardsOnBoard();
  const turnsBefore = h.callsOf("cleo").length;
  compactorUp = true;
  await recover(fleet.main, heard, "retry");
  const done = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "a successful compaction",
  );

  assert.match(
    done.body,
    /compacted its conversation successfully\. Its conversation, branch, and work are as they were\./,
  );
  assert.deepEqual(await cardsOnBoard(), cardsBefore);
  assert.equal(done.card, heard.card);
  assert.ok(
    h
      .callsOf("cleo")
      .slice(turnsBefore)
      .some((turns) =>
        turns.some((turn) => turn.text.includes("ONLY output the structured summary")),
      ),
    "no real compaction ran after the recovery",
  );
  assert.equal(
    h
      .callsOf("cleo")
      .slice(turnsBefore)
      .filter((turns) => !turns.some((turn) => turn.text.includes("ONLY output"))).length,
    0,
  );
  assert.equal(
    heardFailures(fleet.main).filter((entry) => entry.body.includes("compaction failed")).length,
    1,
  );
});

test("a compaction that keeps failing after a recovery spends the attempt and is told once", async () => {
  await compactingCleo(() => false);
  const heard = await fleet.main.waitForEntry(isFailure, "the compaction failure");
  setClock(T0 + 10_000);
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes("is eligible for recovery now"),
    "the eligible time",
  );
  await recover(fleet.main, heard, "retry");
  const failed = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("did not verify"),
    "the failed compaction",
  );

  assert.match(
    failed.body,
    new RegExp(`did not verify: Compaction failed: Summarization failed: ${COMPACTOR_DOWN}`),
  );
  assert.equal(
    fleet.main.entries.filter((push) => push.entry.body.includes("did not verify")).length,
    1,
  );
});
