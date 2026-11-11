import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, OUTSIDE_DATE, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const NOT_HELD =
  "has no hold that waits on the captain now. Hold it first: card_new for the decision if no card carries it, then hold(card, question, options) for the captain (a second mate holds it for main, and main escalates it with to=captain), then name that card";

const needsNext = (card: Card) =>
  new RegExp(
    `^c-${String(card.id)} is a scout: it closes Done only when the close says what happens next\\. Pass next with exactly one of build=.*decision=.*drop=.*captain already asked.*only for a plan.*moot$`,
    "s",
  );

async function deliveredScout(mate: Session = fleet.main): Promise<Card> {
  const card = await newCard(mate, "Plan the file explorer", "scout");
  const worker = await fleet.cardd.connect(await begin(mate, card));
  await worker.call("report", { status: "done", text: "plan written" });
  return card;
}

async function closeScout(
  mate: Session,
  card: Card,
  next: unknown,
  text = "Plan delivered.",
): Promise<void> {
  const args = { card: card.id, next };
  check(OPS["close.begin"].result, await mate.call("close.begin", args));
  await mate.call("close.finish", { ...args, mode: "done", text, archives: [], left: [] });
}

async function closeEntry(card: Card): Promise<Entry> {
  const entry = (await fleet.cardd.thread(card.id)).entries.findLast((e) => e.kind === "cleanup");
  assert.ok(entry !== undefined);
  return entry;
}

async function deliveredShip(title: string): Promise<Card> {
  fleet.cardd.yolo("web");
  const ship = await newCard(fleet.main, title);
  const worker = await fleet.cardd.connect(await begin(fleet.main, ship));
  await worker.call("report", { status: "done", text: "built, no code change" });
  return ship;
}

async function doneShip(title: string): Promise<Card> {
  const ship = await deliveredShip(title);
  await fleet.main.call("close.finish", {
    card: ship.id,
    mode: "done",
    text: "Built.",
    archives: [],
    left: [],
  });
  return ship;
}

test("a scout does not close Done until the close names what happens next, and nothing is torn down", async () => {
  const card = await deliveredScout();
  const refused = needsNext(card);

  await assert.rejects(fleet.main.call("close.begin", { card: card.id }), { message: refused });
  await assert.rejects(fleet.main.call("close.begin", { card: card.id, next: {} }), {
    message: refused,
  });
  await assert.rejects(
    fleet.main.call("close.finish", {
      card: card.id,
      mode: "done",
      text: "Plan delivered.",
      archives: [],
      left: [],
    }),
    { message: refused },
  );
  assert.equal(await status(fleet.main, card), "with-mate");
  assert.deepEqual(
    (await fleet.cardd.thread(card.id)).entries.filter((e) => e.kind === "cleanup"),
    [],
  );
});

test("a scout closed as Dropped needs no next step, and next goes only with a scout's Done close", async () => {
  const scout = await deliveredScout();
  const drop = { drop: "not wanted" };

  await assert.rejects(
    fleet.main.call("close.begin", { card: scout.id, landed: false, next: drop }),
    {
      message: `c-${String(scout.id)} is ending Dropped: next goes only with the Done close of a scout`,
    },
  );
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: scout.id, landed: false }),
  );
  assert.equal(plan.mode, "dropped");
  await fleet.main.call("close.finish", {
    card: scout.id,
    mode: "dropped",
    text: "The captain dropped it.",
    archives: [],
    left: [],
  });
  assert.equal(await status(fleet.main, scout), "dropped");

  const ship = await deliveredShip("Add credit");
  await assert.rejects(fleet.main.call("close.begin", { card: ship.id, next: drop }), {
    message: `c-${String(ship.id)} is a ship card: next goes only with the Done close of a scout`,
  });
});

test("build names the ship card that carries it, open or already Done, and the thread shows it", async () => {
  const open = await newCard(fleet.main, "Build the file explorer");
  const first = await deliveredScout();
  await closeScout(fleet.main, first, { build: open.id });
  assert.equal(await status(fleet.main, first), "done");
  const entry = await closeEntry(first);
  assert.deepEqual(entry.fields["next"], { build: open.id });
  assert.equal(entry.body, `Next: c-${String(open.id)} carries the build.\nPlan delivered.`);
  assert.equal(await status(fleet.main, open), "queued");

  const built = await doneShip("Build the explorer's tree");
  const second = await deliveredScout();
  await closeScout(fleet.main, second, { build: built.id });
  assert.equal(await status(fleet.main, second), "done");
  assert.deepEqual((await closeEntry(second)).fields["next"], { build: built.id });
});

test("decision names an open card whose hold waits on the captain, so it is on his list", async () => {
  const blocked = await newCard(fleet.main, "Build the file explorer");
  await fleet.main.call("hold", {
    card: blocked.id,
    question: "Build the file explorer or drop it?",
    options: ["Build it", "Drop it"],
  });
  const first = await deliveredScout();
  await closeScout(fleet.main, first, { decision: blocked.id });
  assert.equal(await status(fleet.main, first), "done");
  const entry = await closeEntry(first);
  assert.deepEqual(entry.fields["next"], { decision: blocked.id });
  assert.equal(
    entry.body,
    `Next: the captain decides on c-${String(blocked.id)}.\nPlan delivered.`,
  );
  assert.equal(await status(fleet.main, blocked), "needs-you");

  const decision = await newCard(fleet.main, "Build the explorer or drop it?", "captain");
  const second = await deliveredScout();
  const unheld = {
    message: `next decision=${String(decision.id)}: c-${String(decision.id)} ${NOT_HELD}`,
  };
  await assert.rejects(
    fleet.main.call("close.begin", { card: second.id, next: { decision: decision.id } }),
    unheld,
  );
  await assert.rejects(
    fleet.main.call("close.finish", {
      card: second.id,
      mode: "done",
      text: "Plan delivered.",
      archives: [],
      left: [],
      next: { decision: decision.id },
    }),
    unheld,
  );
  assert.equal(await status(fleet.main, second), "with-mate");
  assert.equal(await status(fleet.main, decision), "queued");

  await fleet.main.call("hold", {
    card: decision.id,
    question: "Build the explorer or drop it?",
    options: ["Build it", "Drop it"],
  });
  assert.equal(await status(fleet.main, decision), "needs-you");
  await closeScout(fleet.main, second, { decision: decision.id });
  assert.equal(await status(fleet.main, second), "done");
  assert.deepEqual((await closeEntry(second)).fields["next"], { decision: decision.id });
  assert.equal(await status(fleet.main, decision), "needs-you");
});

test("a decision whose hold is dated is not on the captain's list, so it is refused", async () => {
  const dated = await newCard(fleet.main, "Build the file explorer after the freeze", "captain");
  await fleet.main.call("hold", {
    card: dated.id,
    question: "Build it once the freeze ends?",
    until: Date.now() + 86_400_000,
    ...OUTSIDE_DATE,
  });
  assert.equal(await status(fleet.main, dated), "waiting");
  const scout = await deliveredScout();
  await assert.rejects(
    fleet.main.call("close.begin", { card: scout.id, next: { decision: dated.id } }),
    { message: `next decision=${String(dated.id)}: c-${String(dated.id)} ${NOT_HELD}` },
  );
  assert.equal(await status(fleet.main, scout), "with-mate");
});

test("drop closes Done with the reason on the thread", async () => {
  const card = await deliveredScout();
  await closeScout(fleet.main, card, { drop: "the findings show it is already built" });
  assert.equal(await status(fleet.main, card), "done");
  const entry = await closeEntry(card);
  assert.deepEqual(entry.fields["next"], { drop: "the findings show it is already built" });
  assert.equal(entry.fields["outcome"], "done");
  assert.equal(
    entry.body,
    "Next: nothing is built, because the findings show it is already built.\nPlan delivered.",
  );
});

test("a named card that does not exist is refused, and so is a blank reason", async () => {
  const card = await deliveredScout();
  await assert.rejects(fleet.main.call("close.begin", { card: card.id, next: { build: 9999 } }), {
    message: "next build=9999: no card c-9999",
  });
  await assert.rejects(
    fleet.main.call("close.begin", { card: card.id, next: { decision: 9999 } }),
    { message: "next decision=9999: no card c-9999" },
  );
  await assert.rejects(
    fleet.main.call("close.finish", {
      card: card.id,
      mode: "done",
      text: "Plan delivered.",
      archives: [],
      left: [],
      next: { build: 9999 },
    }),
    { message: "next build=9999: no card c-9999" },
  );
  await assert.rejects(fleet.main.call("close.begin", { card: card.id, next: { drop: " " } }), {
    message: /invalid \/next\/drop/,
  });
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a next step that carries nothing is refused: the wrong kind, a closed card, no hold for the captain, or two routes", async () => {
  const card = await deliveredScout();
  const other = await newCard(fleet.main, "Another report", "scout");
  const ship = await newCard(fleet.main, "Build the file explorer");
  const wait = async (next: unknown): Promise<unknown> =>
    fleet.main.call("close.begin", { card: card.id, next });

  await assert.rejects(wait({ build: other.id }), {
    message: `next build=${String(other.id)}: c-${String(other.id)} is a scout card, so it cannot carry a build: name a ship card`,
  });
  await assert.rejects(wait({ decision: ship.id }), {
    message: `next decision=${String(ship.id)}: c-${String(ship.id)} ${NOT_HELD}`,
  });
  await assert.rejects(wait({ build: ship.id, drop: "moot" }), { message: needsNext(card) });

  await fleet.main.call("close.finish", {
    card: other.id,
    mode: "dropped",
    text: "not needed",
    archives: [],
    left: [],
  });
  await assert.rejects(wait({ decision: other.id }), {
    message: `next decision=${String(other.id)}: c-${String(other.id)} is dropped: a decision needs an open card`,
  });
  await assert.rejects(wait({ build: other.id }), {
    message: `next build=${String(other.id)}: c-${String(other.id)} is a scout card, so it cannot carry a build: name a ship card`,
  });

  const abandoned = await newCard(fleet.main, "Abandoned build");
  await fleet.main.call("close.finish", {
    card: abandoned.id,
    mode: "dropped",
    text: "not needed",
    archives: [],
    left: [],
  });
  await assert.rejects(wait({ build: abandoned.id }), {
    message: `next build=${String(abandoned.id)}: c-${String(abandoned.id)} is dropped, so it carries no build: name the card that does`,
  });
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a second mate's hold that waits only on main is not a decision waiting on the captain", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const scout = await deliveredScout(cleo);
  const blocked = await newCard(cleo, "Build the file explorer");
  await cleo.call("hold", { card: blocked.id, question: "Build it or drop it?" });
  await assert.rejects(
    cleo.call("close.begin", { card: scout.id, next: { decision: blocked.id } }),
    { message: /has no hold that waits on the captain now/ },
  );

  await fleet.main.call("hold", { card: blocked.id, to: "captain", question: "Build it?" });
  await closeScout(cleo, scout, { decision: blocked.id });
  assert.equal(await status(cleo, scout), "done");
  const outcome = await fleet.main.waitForEntry((e) => e.kind === "cleanup", "the outcome");
  assert.deepEqual(outcome.fields["next"], { decision: blocked.id });
});
