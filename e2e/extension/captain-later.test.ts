import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const HOUR = 3_600_000;

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

type Args = Readonly<Record<string, string | number | boolean | readonly number[]>>;

const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

test("main's tools cannot put off a captain's decision: no tool takes the pane's later, and a date on invented words is refused", async () => {
  const card = await newCard(fleet.main, "Renew the certificate", "captain");
  await fleet.main.call("hold", {
    card: card.id,
    question: "Renew it?",
    options: ["Now", "Later"],
  });
  const hold = (await fleet.cardd.board()).holds.find((each) => each.card === card.id)?.hold;
  const typed = { card: card.id, hold: hold ?? 0, said: "tomorrow", zone: "UTC" };
  const date = new Date(Date.now() + HOUR).toISOString();
  const calls: [string, Args][] = [
    ["pane_later", typed],
    ["pane.later", typed],
    ["later", { card: card.id, said: "tomorrow" }],
    [
      "hold",
      {
        card: card.id,
        question: "Renew it?",
        until: date,
        remaining: [],
        said: "snooze it until Friday",
      },
    ],
  ];
  for (const [tool, args] of calls) h.onModel(() => ({ tool, args }));
  h.onModel(() => ({ text: "tried" }));
  const mate = h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("Put the certificate decision off until Friday.");

  const results = toolResults(await h.waitForCall(calls.length));
  assert.match(results[0] ?? "", /Tool pane_later not found/);
  assert.match(results[1] ?? "", /Tool pane\.later not found/);
  assert.match(results[2] ?? "", /Tool later not found/);
  assert.match(results[3] ?? "", /not in the captain's messages or board entries/);

  assert.deepEqual(
    (await fleet.cardd.board()).holds.map((hold) => hold.card),
    [card.id],
    "it still waits for the captain",
  );
  const { entries } = await fleet.cardd.thread(card.id);
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "hold" && entry.author === "captain"),
    [],
  );
});
