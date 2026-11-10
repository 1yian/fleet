import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import {
  begin,
  newCard,
  OUTSIDE_DATE,
  oldDatedHold,
  startFleet,
  status,
  type Fleet,
} from "../support/fleet.ts";

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

const bundleWith = (session: Session, ...cards: Card[]): Promise<Entry> =>
  session.waitForEntry(
    (entry) =>
      entry.fields["condition"] === "decisions" &&
      cards.every((card) => entry.body.includes(name(card))),
    `a decision bundle that lists ${cards.map(name).join(", ")}`,
  );

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

const namesIn = (text: string): string[] =>
  (text.match(/^- c-\d+/gm) ?? []).map((line) => line.slice(2));
const names = (entry: Entry): string[] => entry.body.match(/c-\d+/g) ?? [];
const watchedPart = (entry: Entry): string => entry.body.split(/\n(?=Dated waits)/)[1] ?? "";
const actingPart = (entry: Entry): string => entry.body.split(/\n(?=Dated waits)/)[0] ?? "";
const name = (card: Card): string => `c-${String(card.id)}`;

test("several actionable cards reach their mate as one bundle, repeated flat, and nothing else is sent for them", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const one = await blocked(cleo, "First blocker");
  const two = await blocked(cleo, "Second blocker");
  const three = await blocked(cleo, "Third blocker");

  const first = await bundle(cleo, 1);
  assert.match(
    first.body,
    /^reminder: 3 cards need a decision or action from you\. Date a hold only when a process or an outside event is the blocker/,
  );
  assert.doesNotMatch(first.body, /Waiting on the captain/);
  assert.doesNotMatch(first.body, /so reminders stop/);
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

  const [mateGroup = "", captainGroup = "", extra] = entry.body
    .split("\n")
    .slice(1)
    .join("\n")
    .split(/\n(?=Waiting on the captain)/);
  assert.equal(extra, undefined);
  assert.match(mateGroup, /^You can settle or close these yourself\./);
  assert.match(mateGroup, new RegExp(name(escalated)));
  assert.match(mateGroup, new RegExp(name(own)));
  assert.doesNotMatch(mateGroup, new RegExp(name(decision)));
  assert.match(captainGroup, /^Waiting on the captain\. Do not list them in chat/);
  assert.doesNotMatch(captainGroup, /short list|catch-up|afk/);
  assert.match(captainGroup, new RegExp(name(decision)));
  assert.doesNotMatch(captainGroup, new RegExp(name(own)));
});

test("a card held until a date drops out of the bundle, and comes back when the date passes", async () => {
  const kept = await blocked(fleet.main, "Kept blocker");
  const snoozed = await blocked(fleet.main, "Snoozed blocker");
  const until = Date.now() + 5_000;
  await fleet.main.call("hold", { card: snoozed.id, question: "later?", until, ...OUTSIDE_DATE });

  const first = await bundle(fleet.main, 1);
  assert.deepEqual(namesIn(actingPart(first).split("\n").slice(1).join("\n")), [name(kept)]);
  assert.deepEqual(namesIn(watchedPart(first)), [name(snoozed)]);
  assert.ok(Date.now() < until, "the first bundle arrived before the hold ended");
  const later = await fleet.main.waitForEntry(
    (entry) =>
      entry.fields["condition"] === "decisions" && actingPart(entry).includes(name(snoozed)),
    "the snoozed card back in a bundle for action",
  );
  assert.ok(later.createdAt * 1000 >= until - 1000);
  assert.deepEqual(names(later).sort(), [kept, snoozed].map(name).sort());
});

test("a worker that waits on its mate cannot pause: it is refused and listed once it reports blocked, while a dated pause stays off the list", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const waiting = await newCard(cleo, "Waits on its mate");
  const quota = await newCard(cleo, "Waits on a quota");
  const waitingWorker = await fleet.cardd.connect(await begin(cleo, waiting));
  const quotaWorker = await fleet.cardd.connect(await begin(cleo, quota));
  const slot = { status: "paused", text: "waiting for you to relay the slot" };
  await quotaWorker.call("report", {
    status: "paused",
    text: "the quota resets in an hour",
    until: Date.now() + 3_600_000,
  });

  await assert.rejects(waitingWorker.call("report", slot), /report blocked instead/);
  await assert.rejects(
    waitingWorker.call("report", { ...slot, until: Date.now() - 1_000 }),
    /report blocked instead/,
  );
  assert.equal(await status(cleo, waiting), "working");
  await waitingWorker.call("report", { ...slot, status: "blocked" });

  assert.deepEqual(names(await bundle(cleo, 1)), [name(waiting)]);
  assert.deepEqual(names(await bundle(cleo, 2)), [name(waiting)]);
  assert.equal(await status(cleo, quota), "paused");
});

const HOUR = 3_600_000;

test("a dated wait with something behind it is listed as information, and an idle park is listed for action", async () => {
  const { main } = fleet;
  const act = await blocked(main, "Blocked on the mate");
  const quota = await newCard(main, "Waits on the quota");
  await main.call("hold", {
    card: quota.id,
    question: "Quota resets?",
    until: Date.now() + HOUR,
    outside: "the weekly quota resets",
    remaining: [],
  });
  const watched = await newCard(main, "Watched by a worker");
  await fleet.cardd.connect(await begin(main, watched));
  const park = await newCard(main, "Parked on a worker");
  await main.call("hold", {
    card: park.id,
    question: "Is the worker done?",
    until: Date.now() + HOUR,
    worker: watched.id,
    remaining: [],
  });
  await main.call("close.finish", {
    card: watched.id,
    mode: "dropped",
    text: "dropped",
    archives: [],
    left: [],
  });

  const entry = await bundleWith(main, act, quota, park);
  assert.match(entry.body, /^reminder: 2 cards need a decision or action from you\./);
  assert.doesNotMatch(entry.body, /Waiting on the captain/);
  const acting = actingPart(entry);
  assert.match(acting, /^reminder: .*\nYou can settle or close these yourself\./);
  assert.deepEqual(
    namesIn(acting.split("\n").slice(1).join("\n")).sort(),
    [act, park].map(name).sort(),
  );
  assert.match(
    acting,
    new RegExp(
      `- ${name(park)} Parked on a worker - idle park, nothing running: the worker of ${name(watched)} is not running, until \\S+Z \\(in \\d+[hm]\\), held [<\\d]+m?: Is the worker done\\?`,
    ),
  );
  const watching = watchedPart(entry);
  assert.match(watching, /^Dated waits .*Information only, no action now:/);
  assert.deepEqual(namesIn(watching.split("\n").slice(1).join("\n")), [name(quota)]);
  assert.match(
    watching,
    new RegExp(
      `- ${name(quota)} Waits on the quota - waits on an outside date: the weekly quota resets, until \\S+Z \\(in \\d+[hm]\\), held [<\\d]+m?: Quota resets\\?`,
    ),
  );
});

test("dated waits alone send no reminder, and a card held for the captain's later is told apart from one parked with nothing running", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const quinn = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));
  await blocked(quinn, "Clock for the test");
  const quota = await newCard(cleo, "Waits on the quota");
  await cleo.call("hold", {
    card: quota.id,
    question: "Quota resets?",
    until: Date.now() + HOUR,
    outside: "the weekly quota resets",
    remaining: [],
  });
  const later = await newCard(fleet.main, "Captain said later", "captain");
  const words = "Not this week, ask me Monday.";
  assert.equal(await fleet.cardd.act(later.id, { kind: "comment", text: words }), 200);
  await fleet.main.call("hold", {
    card: later.id,
    question: "Pick the vendor?",
    until: Date.now() + HOUR,
    said: words,
    source: "record",
    remaining: [],
  });
  await bundle(quinn, 2);
  assert.deepEqual(bundles(fleet.main), []);
  assert.deepEqual(bundles(cleo), []);

  const forgotten = await newCard(fleet.main, "Forgotten decision", "captain");
  oldDatedHold(fleet.cardd, forgotten, "captain", Date.now() - 5 * 24 * HOUR, Date.now() + HOUR);
  const entry = await bundleWith(fleet.main, forgotten, later, quota);
  assert.match(entry.body, /^reminder: 1 card needs a decision or action from you\./);
  const acting = actingPart(entry).split("\n").slice(1).join("\n");
  assert.deepEqual(namesIn(acting), [name(forgotten)]);
  assert.match(
    acting,
    /idle park, nothing running, until \S+Z \(in \d+[hm]\), held 5d: Wait for it\?/,
  );
  const watching = watchedPart(entry).split("\n").slice(1).join("\n");
  assert.deepEqual(namesIn(watching).sort(), [later, quota].map(name).sort());
  assert.match(watching, /the captain said later: "Not this week, ask me Monday\."/);
  assert.doesNotMatch(entry.body, /Waiting on the captain/);
  assert.deepEqual(bundles(cleo), []);
});
