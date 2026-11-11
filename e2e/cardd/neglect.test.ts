import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { ageCard, newCard, startFleet, type Fleet } from "../support/fleet.ts";

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

const reminder = (to: Session): Promise<Entry> =>
  to.waitForEntry(
    (entry) => entry.author === "check" && entry.fields["condition"] === "decisions",
    "the reminder",
  );

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

test("a card idle past the limit is listed for its mate to act on, and a younger one is not named", async () => {
  const young = await newCard(cleo, "Port the calendar");
  ageCard(fleet.cardd, young, 4 * HOUR * SCALE - MINUTE);
  const idle = await newCard(cleo, "Port the invoices");
  ageCard(fleet.cardd, idle, 4 * HOUR * SCALE + MINUTE);

  const { body } = await reminder(cleo);
  assert.match(
    body,
    new RegExp(
      `^reminder: 1 card needs a decision or action from you\\..*\\nYou can settle or close these yourself\\..*:\\n- c-${String(idle.id)} Port the invoices - idle \\d+ min, nothing running and no stated reason$`,
      "s",
    ),
  );
  assert.ok(!body.includes("Port the calendar"), "a card under the limit is not named");
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
});
