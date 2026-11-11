import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { ageCard, begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
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

async function park(card: Card, ms: number): Promise<void> {
  await cleo.call("hold", {
    card: card.id,
    question: "Wait for it?",
    until: Date.now() + HOUR,
    watcher: "the support hub log",
    remaining: [],
  });
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

test("a list for an action names a card parked for over a day once, and not again on the 30 minute cadence", async () => {
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
  assert.equal(naming("Crud ingress card").length, 1, "the parked card is in one list");
});

test("a card parked for over a day on a wait nothing checks is named once a day, with what to do", async () => {
  const young = await newCard(cleo, "Quota card");
  await park(young, 24 * HOUR * SCALE - 2 * MINUTE);
  const parked = await newCard(cleo, "Crud ingress card");
  await park(parked, 24 * HOUR * SCALE + 2 * MINUTE);

  const { body } = await reminder(fleet.main);
  assert.match(
    body,
    new RegExp(
      `^reminder: 1 card parked for over a day, nothing checks what it waits for\\..*\\nParked for more than a day on a wait that fleet cannot check\\. Start what it waits on, or clear the hold and act on it:\\n- c-${String(parked.id)} Crud ingress card - waits on the support hub log \\(fleet cannot check it\\)`,
      "s",
    ),
  );
  const lines = body.split("\n");
  const from = lines.findIndex((line) => line.startsWith("Parked for more than a day")) + 1;
  const named = lines.slice(from);
  const section = named.slice(
    0,
    named.findIndex((line) => !line.startsWith("- ")),
  );
  assert.equal(section.length, 1, `the parked group is ${section.join(" | ")}`);
  assert.deepEqual(await reminderOn(cleo, parked), [], "the mate that holds it is not told");
});

test("a card the captain put off, which its own mate holds, is named for main after a day and not for its mate", async () => {
  const later = await newCard(cleo, "Launch the referral page");
  const status = await fleet.cardd.act(later.id, {
    kind: "hold",
    until: Date.now() + 10 * HOUR,
    reason: "after the launch",
  });
  assert.equal(status, 200);
  ageCard(fleet.cardd, later, 24 * HOUR * SCALE + 2 * MINUTE);

  const { body } = await reminder(fleet.main);
  assert.match(
    body,
    new RegExp(
      `^reminder: 1 card parked for over a day, nothing checks what it waits for\\..*\\n- c-${String(later.id)} Launch the referral page - the captain said later: "after the launch"`,
      "s",
    ),
  );
  assert.deepEqual(await reminderOn(cleo, later), [], "the mate that holds it is not told");
});

test("a worker's pause past a day is listed for main with what to do, and not for its mate", async () => {
  const paused = await newCard(cleo, "Wait for the CI run");
  const worker = await fleet.cardd.connect(await begin(cleo, paused));
  try {
    await worker.call("report", { status: "paused", text: "CI runs", until: Date.now() + HOUR });
    ageCard(fleet.cardd, paused, 24 * HOUR * SCALE + 2 * MINUTE);

    const { body } = await reminder(fleet.main);
    assert.match(
      body,
      new RegExp(
        `^reminder: 1 card parked for over a day, nothing checks what it waits for\\..*\\nParked for more than a day on a wait that fleet cannot check\\. Start what it waits on, or clear the hold and act on it:\\n- c-${String(paused.id)} Wait for the CI run - paused \\d+ min, nothing checks what it waits for$`,
        "s",
      ),
    );
    assert.deepEqual(await reminderOn(cleo, paused), [], "its mate is not told");
  } finally {
    await worker.close();
  }
});
