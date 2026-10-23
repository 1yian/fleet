import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const bundles = (session: Session): Entry[] =>
  session.entries
    .map(({ entry }) => entry)
    .filter((entry) => entry.author === "check" && entry.fields["condition"] === "decisions");

const bundle = (session: Session, n: number): Promise<Entry> =>
  session.waitForEntry(
    (entry) => entry.fields["condition"] === "decisions" && Number(entry.fields["tier"]) >= n,
    `decision bundle ${String(n)}`,
  );

async function blocked(mate: Session, title: string): Promise<Card> {
  const card = await newCard(mate, title);
  const worker = await fleet.cardd.connect(await begin(mate, card));
  await worker.call("report", { status: "blocked", text: `${title} is stuck` });
  return card;
}

const names = (entry: Entry): string[] => entry.body.match(/c-\d+/g) ?? [];
const name = (card: Card): string => `c-${String(card.id)}`;

test("several actionable cards reach their mate as one bundle, repeated flat, and nothing else is sent for them", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const one = await blocked(cleo, "First blocker");
  const two = await blocked(cleo, "Second blocker");
  const three = await blocked(cleo, "Third blocker");

  const first = await bundle(cleo, 1);
  assert.match(
    first.body,
    /^reminder: 3 cards need a decision or action from you\. Act on each now\./,
  );
  assert.match(first.body, /hold it with until=<date>/);
  assert.deepEqual(names(first).sort(), [one, two, three].map(name).sort());
  const second = await bundle(cleo, 2);
  assert.deepEqual(names(second).sort(), names(first).sort());
  assert.equal(second.createdAt - first.createdAt >= 1, true);
  assert.deepEqual(
    cleo.entries
      .map(({ entry }) => entry)
      .filter((entry) => entry.author === "check" && entry.fields["condition"] === "reminder"),
    [],
  );
});

test("a mate with nothing to act on hears no bundle, and each mate hears only its own cards", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const quiet = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));
  const mine = await blocked(cleo, "Cleo blocker");
  const theirs = await blocked(fleet.main, "Main blocker");

  const forCleo = await bundle(cleo, 2);
  const forMain = await bundle(fleet.main, 2);
  assert.deepEqual(names(forCleo), [name(mine)]);
  assert.deepEqual(names(forMain), [name(theirs)]);
  assert.deepEqual(bundles(quiet), []);
});

test("main's bundle holds its own cards, an escalated hold, and every captain decision marked as the captain's", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const escalated = await newCard(cleo, "Budget question");
  await cleo.call("hold", { card: escalated.id, question: "Raise the budget?", options: ["No"] });
  const decision = await newCard(cleo, "Captain pick");
  await cleo.call("hold", { card: decision.id, question: "Which one?" });
  await fleet.main.call("hold", { card: decision.id, question: "Which one?", to: "captain" });
  const own = await blocked(fleet.main, "Main blocker");

  const entry = await bundle(fleet.main, 1);
  assert.deepEqual(names(entry).sort(), [escalated, decision, own].map(name).sort());
  const lines = entry.body.split("\n");
  assert.match(lines.find((l) => l.includes(name(decision))) ?? "", /waiting on the captain/);
  assert.doesNotMatch(
    lines.find((l) => l.includes(name(escalated))) ?? "",
    /waiting on the captain/,
  );
  assert.doesNotMatch(lines.find((l) => l.includes(name(own))) ?? "", /waiting on the captain/);
  assert.deepEqual(bundles(cleo), []);
});

test("a card held until a date drops out of the bundle, and comes back when the date passes", async () => {
  const kept = await blocked(fleet.main, "Kept blocker");
  const snoozed = await blocked(fleet.main, "Snoozed blocker");
  const until = Date.now() + 5_000;
  await fleet.main.call("hold", { card: snoozed.id, question: "later?", until });

  const first = await bundle(fleet.main, 1);
  assert.deepEqual(names(first), [name(kept)]);
  assert.ok(Date.now() < until, "the first bundle arrived before the hold ended");
  const later = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "decisions" && entry.body.includes(name(snoozed)),
    "the snoozed card back in a bundle",
  );
  assert.ok(later.createdAt * 1000 >= until - 1000);
  assert.deepEqual(names(later).sort(), [kept, snoozed].map(name).sort());
});
