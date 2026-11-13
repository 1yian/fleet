import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { ageCard, ageCards, begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

const SCALE = 0.01;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: String(SCALE) });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await Promise.allSettled([cleo.close()]);
  await fleet.cardd.stop();
});

const isReminder = (entry: Entry): boolean =>
  entry.author === "check" && entry.fields["condition"] === "decisions";

const reminder = (to: Session): Promise<Entry> => to.waitForEntry(isReminder, "the reminder");

async function reminderOn(mate: Session, card: Card): Promise<Entry[]> {
  const view = check(OPS.card.result, await mate.call("card", { card: card.id }));
  return view.entries.filter(isReminder);
}

const watch = (card: Card): Promise<unknown> =>
  cleo.call("hold", {
    card: card.id,
    question: "Wait for it?",
    until: Date.now() + HOUR,
    watcher: "the support hub log",
    remaining: [],
  });

async function park(card: Card, ms: number): Promise<void> {
  await watch(card);
  ageCard(fleet.cardd, card, ms);
}

test("a card idle past the limit is listed for main and not for the mate that owns it, and a younger one is not named", async () => {
  const young = await newCard(cleo, "Port the calendar");
  ageCard(fleet.cardd, young, 4 * HOUR * SCALE - MINUTE);
  const idle = await newCard(cleo, "Port the invoices");
  ageCard(fleet.cardd, idle, 4 * HOUR * SCALE + MINUTE);

  const { body } = await reminder(fleet.main);
  assert.match(
    body,
    new RegExp(
      `^reminder: 1 card needs a decision or action from you\\..*\\nYou can settle or close these yourself\\..*:\\n- c-${String(idle.id)} Port the invoices - idle \\d+ min, nothing running and no stated reason$`,
      "s",
    ),
  );
  assert.ok(!body.includes("Port the calendar"), "a card under the limit is not named");
  assert.deepEqual(await reminderOn(cleo, idle), [], "the mate that owns it is not told");
  assert.equal((await reminderOn(fleet.main, idle)).length, 1, "main reads it on the card");
});

test("a card its worker handed back and nobody closed is idle too: main is told after 4 hours, and its mate keeps its own reminders", async () => {
  const handed = await newCard(cleo, "Check the ads budget", "scout");
  const worker = await fleet.cardd.connect(await begin(cleo, handed));
  try {
    await worker.call("report", { status: "done", text: "checked" });
    ageCard(fleet.cardd, handed, 4 * HOUR * SCALE + MINUTE);

    const { body } = await reminder(fleet.main);
    assert.match(
      body,
      new RegExp(
        `^reminder: 1 card needs a decision or action from you\\..*\\n- c-${String(handed.id)} Check the ads budget - idle \\d+ min, nothing running and no stated reason$`,
        "s",
      ),
    );
    assert.deepEqual(await reminderOn(cleo, handed), [], "the list for main is not its mate's");
    const own = await cleo.waitForEntry(
      (entry) => entry.author === "check" && entry.fields["condition"] === "finished",
      "its mate's finished reminder",
    );
    assert.match(
      own.body,
      new RegExp(`^reminder: c-${String(handed.id)} is finished and still open`),
    );
  } finally {
    await worker.close();
  }
});

test("a card that main already holds is in main's list once, with the hold, not again as idle", async () => {
  const asked = await newCard(cleo, "Pick the vendor");
  await cleo.call("hold", { card: asked.id, question: "Which vendor?", to: "main" });
  ageCard(fleet.cardd, asked, 4 * HOUR * SCALE + MINUTE);

  const { body } = await reminder(fleet.main);
  assert.equal(body.match(new RegExp(`c-${String(asked.id)} `, "g"))?.length, 1, body);
  assert.match(body, new RegExp(`c-${String(asked.id)} Pick the vendor \\(with-mate, main hold`));
  assert.doesNotMatch(body, /idle \d+ min/);
});

test("an action list carries an armed watcher only as information, never as work to act on", async () => {
  const parked = await newCard(cleo, "Crud ingress card");
  await park(parked, 24 * HOUR * SCALE + 2 * MINUTE);
  const idle = await newCard(cleo, "Port the invoices");
  ageCard(fleet.cardd, idle, 4 * HOUR * SCALE + MINUTE);

  const naming = (title: string): Entry[] =>
    fleet.main.entries
      .map(({ entry }) => entry)
      .filter((entry) => isReminder(entry) && entry.body.includes(title));
  await until(
    () => (naming("Port the invoices").length >= 2 ? true : undefined),
    "two lists that name the idle card",
  );
  const lists = naming("Port the invoices");
  assert.equal(lists.length, 2, "two action lists were observed");
  for (const { body } of lists) {
    const [actions = "", information = ""] = body.split("Dated waits with something running");
    assert.doesNotMatch(actions, /Crud ingress card/);
    assert.match(information, /Crud ingress card/);
  }
});

test("declared watchers stay information-only regardless of the age of their holds", async () => {
  const young = await newCard(cleo, "Quota card");
  await park(young, 24 * HOUR * SCALE - 2 * MINUTE);
  const parked = await newCard(cleo, "Crud ingress card");
  await park(parked, 24 * HOUR * SCALE + 2 * MINUTE);

  const { body } = await reminder(fleet.main);
  assert.match(body, /^information: 2 dated waits, nothing needs action/);
  assert.match(body, /Quota card/);
  assert.match(body, /Crud ingress card - waits on the support hub log/);
  const board = check(OPS.board.result, await cleo.call("board", {}));
  assert.deepEqual(
    [young, parked].map(({ id }) => {
      const pulse = board.find((each) => each.id === id)?.pulse;
      return [pulse?.state, pulse?.notice];
    }),
    [
      ["waiting", "none"],
      ["waiting", "none"],
    ],
  );
});

test("captain deferrals and declared watchers both stay off action lists however old they are", async () => {
  const later = await newCard(cleo, "Launch the referral page");
  const question = "Launch it now?";
  await cleo.call("hold", { card: later.id, question });
  await fleet.main.call("hold", { card: later.id, question, to: "captain" });
  const asked = (await fleet.cardd.board()).holds.find((each) => each.card === later.id);
  assert.ok(asked !== undefined, "the captain is asked");
  const status = await fleet.cardd.act(later.id, {
    kind: "hold",
    hold: asked.hold,
    said: "in 10 hours",
    zone: "UTC",
  });
  assert.equal(status, 200);
  const parked = await newCard(cleo, "Crud ingress card");
  await watch(parked);
  ageCards(fleet.cardd, [later, parked], 24 * HOUR * SCALE + 2 * MINUTE);

  const { body } = await reminder(fleet.main);
  assert.match(body, /^information: 2 dated waits, nothing needs action/);
  assert.match(body, /Crud ingress card/);
  const [toAct = ""] = body.split("Dated waits with something running");
  assert.doesNotMatch(toAct, /Launch the referral page/);
  const told = await reminderOn(cleo, later);
  assert.ok(
    told.every((entry) => entry.body.startsWith("information:")),
    "the mate that holds it is told nothing to act on",
  );
});

test("arming an old hold with an outside checkpoint makes it waiting instead of neglected", async () => {
  const held = await newCard(cleo, "Crud ingress card");
  await cleo.call("hold", { card: held.id, question: "Wait for it?" });
  ageCard(fleet.cardd, held, 24 * HOUR * SCALE + 2 * MINUTE);
  await cleo.call("hold", {
    card: held.id,
    question: "Wait for it?",
    until: Date.now() + HOUR,
    outside: "the first real support hub interaction",
    remaining: [],
  });

  const board = check(OPS.board.result, await cleo.call("board", {}));
  const pulse = board.find(({ id }) => id === held.id)?.pulse;
  assert.deepEqual([pulse?.state, pulse?.notice], ["waiting", "none"]);
  const dated = board.find(({ id }) => id === held.id)?.datedWait;
  assert.equal(dated?.watch, "outside");
  assert.equal(dated.what, "the first real support hub interaction");
});

test("a worker's future dated checkpoint is not listed for action even after a day", async () => {
  const paused = await newCard(cleo, "Wait for the CI run");
  const worker = await fleet.cardd.connect(await begin(cleo, paused));
  try {
    await worker.call("report", { status: "paused", text: "CI runs", until: Date.now() + HOUR });
    ageCard(fleet.cardd, paused, 24 * HOUR * SCALE + 2 * MINUTE);

    const idle = await newCard(cleo, "Unattended control");
    ageCard(fleet.cardd, idle, 4 * HOUR * SCALE + MINUTE);
    const { body } = await reminder(fleet.main);
    assert.match(body, /Unattended control/);
    assert.doesNotMatch(body, /Wait for the CI run/);
    const board = check(OPS.board.result, await cleo.call("board", {}));
    const pulse = board.find(({ id }) => id === paused.id)?.pulse;
    assert.deepEqual([pulse?.state, pulse?.notice], ["waiting", "none"]);
    assert.deepEqual(await reminderOn(cleo, paused), [], "its mate is not told");
  } finally {
    await worker.close();
  }
});
