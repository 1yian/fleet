import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import { newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const DUE = "Bring this one up now:";

async function held(title: string, question: string): Promise<Card> {
  const card = await newCard(fleet.main, title);
  await fleet.main.call("hold", { card: card.id, question });
  return card;
}

async function seen(away = false): Promise<number> {
  const args = away ? { away } : {};
  return check(OPS["captain.seen"].result, await fleet.main.call("captain.seen", args)).entry;
}

async function occurrenceOf(card: Card): Promise<number> {
  const view = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
  assert.ok(view.hold !== null);
  return view.hold.occurrence;
}

const presentAt = async (card: Card, occurrence: number): Promise<number> =>
  check(OPS.presented.result, await fleet.main.call("presented", { card: card.id, occurrence }))
    .waiting;

const present = async (card: Card): Promise<number> => presentAt(card, await occurrenceOf(card));

async function untilStatus(card: Card, status: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const view = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
    if (view.card.status === status) return;
    assert.ok(Date.now() < deadline, `timed out waiting for c-${String(card.id)} to be ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function due(): Promise<number | undefined> {
  const found = check(OPS["decision.due"].result, await fleet.main.call("decision.due", {}));
  return found?.card;
}

const listAfter = (entry: number, what: string, match: (body: string) => boolean) =>
  fleet.main.waitForEntry(
    (each: Entry) =>
      each.fields["condition"] === "decisions" && each.id > entry && match(each.body),
    what,
  );

const captainGroup = (body: string): string => body.split(/\n(?=Waiting on the captain)/)[1] ?? "";
const dueLines = (body: string): string[] => body.split("\n").filter((line) => line.includes(DUE));

test("main's list carries one decision to bring up now, picked from his messages and from what was shown", async () => {
  const older = await held("Staff-call upload", "Ship it to staging today?");
  const newer = await held("Prod tag policy", "Let platform own it?");

  const quiet = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "decisions",
    "a list before he has written",
  );
  assert.deepEqual(dueLines(quiet.body), []);
  assert.match(captainGroup(quiet.body), /^Waiting on the captain\. None is due: /);

  const first = await listAfter(await seen(), "the list after his first message", (body) =>
    body.includes(DUE),
  );
  assert.deepEqual(dueLines(first.body), [
    `- ${DUE} c-${String(older.id)} Staff-call upload: Ship it to staging today?`,
  ]);
  assert.match(captainGroup(first.body), /^Waiting on the captain\. He has written to you since/);
  assert.match(captainGroup(first.body), /"\+1 more waiting" for the others/);
  assert.match(
    first.body,
    new RegExp(`- c-${String(newer.id)} Prod tag policy - waiting on the captain \\(\\d+ min\\)`),
  );
  assert.equal(await present(older), 1);

  const spent = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "decisions" && entry.body.includes("(shown since his"),
    "a list after the first decision was brought up",
  );
  assert.deepEqual(dueLines(spent.body), []);
  assert.match(
    spent.body,
    new RegExp(`c-${String(older.id)} .*\\(shown since his last message\\)`),
  );
  assert.doesNotMatch(spent.body, new RegExp(`c-${String(newer.id)} .*shown since`));

  const second = await listAfter(await seen(), "the list after his next message", (body) =>
    body.includes(DUE),
  );
  assert.match(dueLines(second.body).join("\n"), new RegExp(`c-${String(newer.id)} Prod tag`));
  assert.equal(dueLines(second.body).length, 1);
});

test("the next decision is due only after he writes again, rotating to the one shown least recently", async () => {
  const older = await held("Staff-call upload", "Ship it?");
  const newer = await held("Prod tag policy", "Own it?");
  assert.equal(await due(), undefined);

  await seen();
  assert.equal(await due(), older.id);
  assert.equal(await present(older), 1);
  assert.equal(await due(), undefined);

  await seen();
  assert.equal(await due(), newer.id);
  await present(newer);
  assert.equal(await due(), undefined);

  await seen();
  assert.equal(await due(), older.id);
});

test("presenting a decision spends the captain's message even after that hold clears, and survives a cardd restart", async () => {
  const first = await held("Staff-call upload", "Ship it?");
  const second = await held("Prod tag policy", "Own it?");
  await seen();
  await present(first);
  const open = (await fleet.cardd.board()).holds.find((each) => each.card === first.id);
  assert.ok(open !== undefined);
  await fleet.cardd.act(first.id, { kind: "answer", hold: open.hold, choice: "Yes" });
  assert.equal(await due(), undefined);
  await fleet.main.close();
  await fleet.cardd.restart();
  fleet = { ...fleet, main: await fleet.cardd.connect(fleet.mainToken) };
  assert.equal(await due(), undefined);
  await seen();
  assert.equal(await due(), second.id);
});

test("afk is recorded as away: nothing is due until he writes again", async () => {
  const card = await held("Staff-call upload", "Ship it?");
  await seen();
  assert.equal(await due(), card.id);

  await seen(true);
  assert.equal(await due(), undefined);
  const gone = await listAfter(await seen(true), "a list while he is away", () => true);
  assert.deepEqual(dueLines(gone.body), []);

  await seen();
  assert.equal(await due(), card.id);
});

test("a decision held again after it was answered starts unshown", async () => {
  const first = await held("Staff-call upload", "Ship it?");
  const second = await held("Prod tag policy", "Own it?");
  await seen();
  await present(first);
  await seen();
  await present(second);

  const { holds } = await fleet.cardd.board();
  const open = holds.find((each) => each.card === second.id);
  assert.ok(open !== undefined);
  await fleet.cardd.act(second.id, { kind: "answer", hold: open.hold, choice: "Yes" });
  await fleet.main.call("hold", { card: second.id, question: "Own it, with a review?" });

  await seen();
  assert.equal(await due(), second.id);
});

test("only a decision that waits on the captain is brought up, only main records it, and the marks stay out of his thread", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const plain = await newCard(fleet.main, "No question yet");
  const card = await held("Staff-call upload", "Ship it?");

  await assert.rejects(
    fleet.main.call("presented", { card: plain.id, occurrence: 1 }),
    /not waiting on the captain, so nothing was recorded/,
  );
  for (const [op, args] of [
    ["presented", { card: card.id, occurrence: 1 }],
    ["captain.seen", {}],
    ["walkthrough", { paused: true }],
    ["decision.due", {}],
  ] as const)
    await assert.rejects(cleo.call(op, args), /only main records what the captain has been told/);

  await seen();
  await present(card);
  const view = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
  const marks = view.entries.filter((entry) => entry.kind === "note");
  assert.deepEqual(
    marks.map(({ fields }) => ({ ...fields })),
    [{ mark: "presented", hold: view.hold?.entry, occurrence: 1 }],
  );
  assert.deepEqual(
    (await fleet.cardd.thread(card.id)).entries.filter((entry) => entry.kind === "note"),
    [],
  );
  assert.equal(
    (await fleet.cardd.board()).cards.some((each) => each.name === "captain-log"),
    false,
  );
  await cleo.close();
});

test("a presentation checked against an earlier hold occurrence is refused, and the replacement decision stays due", async () => {
  const card = await held("Staff-call upload", "Ship it?");
  const checked = await occurrenceOf(card);
  const open = (await fleet.cardd.board()).holds.find((each) => each.card === card.id);
  assert.ok(open !== undefined);
  await fleet.cardd.act(card.id, { kind: "answer", hold: open.hold, choice: "Yes" });
  await fleet.main.call("hold", { card: card.id, question: "Ship it, with a review?" });
  assert.equal(await occurrenceOf(card), checked + 1);

  await seen();
  await assert.rejects(presentAt(card, checked), /held again since you checked it/);
  assert.equal(await due(), card.id);
  assert.equal(await presentAt(card, checked + 1), 0);
  assert.equal(await due(), undefined);
});

test("a captain decision whose date has passed rejoins the rotation and is counted as waiting", async () => {
  const dated = await newCard(fleet.main, "Staff-call upload");
  await fleet.main.call("hold", {
    card: dated.id,
    question: "Ship it?",
    until: Date.now() + 2_000,
    outside: "the vendor answers on Monday",
    remaining: [],
  });
  const other = await held("Prod tag policy", "Own it?");

  await seen();
  assert.equal(await due(), other.id);
  assert.equal(await presentAt(other, await occurrenceOf(other)), 0);

  await untilStatus(dated, "needs-you");
  await seen();
  assert.equal(await due(), dated.id);
  assert.equal(await present(dated), 1);
  await seen();
  assert.equal(await due(), other.id);
});

test("a paused walkthrough makes nothing due, even after he writes, until it is resumed", async () => {
  const older = await held("Staff-call upload", "Ship it?");
  await held("Prod tag policy", "Own it?");
  await seen();
  assert.equal(await due(), older.id);

  const paused = check(
    OPS.walkthrough.result,
    await fleet.main.call("walkthrough", { paused: true }),
  );
  assert.deepEqual(paused, { paused: true });
  assert.equal(await due(), undefined);
  await seen();
  assert.equal(await due(), undefined);
  const quiet = await listAfter(await seen(), "a list while paused", () => true);
  assert.deepEqual(dueLines(quiet.body), []);
  assert.match(captainGroup(quiet.body), /^Waiting on the captain\. None is due: /);

  await fleet.main.call("walkthrough", { paused: false });
  assert.equal(await due(), older.id);
  assert.equal(
    (await fleet.cardd.board()).cards.some((each) => each.name === "captain-log"),
    false,
  );
});
