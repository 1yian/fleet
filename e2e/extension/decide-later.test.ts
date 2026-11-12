import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, MERGE_OPTIONS, OPS, type Card } from "@fleet/protocol";
import {
  cardRows,
  DecideLab,
  keep,
  MY_WORDS,
  onCard,
  SEEN,
  SHIP,
  showing,
} from "../support/decide-lab.ts";

const PR = "https://github.com/acme/web/pull/7";
const MERGE_ASK = `Merge ${PR}?`;
const LANE_ASK = "What should the lane be called?";
const WAIT_MS = 60_000;

let lab: DecideLab;
beforeEach(async () => {
  lab = await DecideLab.start({ TZ: "Asia/Tokyo" });
});
afterEach(async (t) => {
  await lab.stop(t);
});

async function captainHolds(card: Card): Promise<{ until: unknown; wait: unknown }[]> {
  const { entries } = await lab.cardd.thread(card.id);
  return entries
    .filter((entry) => entry.kind === "hold" && entry.author === "captain")
    .map((entry) => ({ until: entry.fields["until"], wait: entry.fields["wait"] }));
}

async function mergeAskedMain(pane: string, count: number): Promise<Card> {
  lab.cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  const args = { title: "Ads exports", kind: "ship", project: "web" };
  const card = check(CardSchema, await lab.cleo.call("card.new", args));
  const begin = await lab.cleo.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "export the ads",
  });
  const worker = await lab.cardd.connect(check(OPS["attempt.begin"].result, begin).token);
  lab.cardd.gh.setPr(PR, "OPEN");
  lab.h.onModel(
    () => ({ tool: "hold", args: { card: card.id, question: MERGE_ASK, to: "captain" } }),
    "mate",
  );
  lab.h.onModel(() => ({ text: SEEN }), "mate");
  await worker.call("report", { status: "done", text: "PR ready", pr: PR });
  await lab.screenWhere(pane, `${String(count)} on the strip`, showing([`◆ ${String(count)}`]));
  await lab.h.waitForCall(count * 2 - 1, "mate", WAIT_MS);
  return card;
}

test("Later sits under his own words, and the words he types hold the decision as his dated later", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);

  await lab.herdr().submit(pane, "/d");
  keep(
    "later-1-rows",
    await lab.screenWhere(
      pane,
      "Later under his words",
      onCard(["Decision 1 of 1", SHIP, "Ship it", "Hold", "My words…", "Later…", "esc close"]),
    ),
  );

  await lab.herdr().press(pane, "down", "down", "down");
  keep(
    "later-2-pointer",
    await lab.screenWhere(
      pane,
      "the pointer on Later",
      onCard(["→ Later…", "tomorrow, Friday 4PM", "type until when"], ["⏎ select"]),
    ),
  );
  await lab.herdr().type(pane, "Dec 31 2099 4PM");
  keep(
    "later-3-typed",
    await lab.screenWhere(
      pane,
      "his time on the Later row",
      onCard(["→ Dec 31 2099 4PM", "⏎ hold", "esc clear"], ["type until when"]),
    ),
  );
  assert.equal((await lab.cardd.board()).holds.length, 1, "typing holds nothing");

  await lab.herdr().press(pane, "enter");
  const held = await lab.screenWhere(
    pane,
    "the card to close with the time it holds until",
    (screen) =>
      cardRows(screen).length === 0 &&
      showing([
        `c-${String(ship.id)} comes back to you Thu, Dec 31, 2099, 4:00 PM GMT+9 (Asia/Tokyo)`,
      ])(screen),
  );
  keep("later-4-held", held);
  assert.deepEqual(await captainHolds(ship), [
    {
      until: Date.UTC(2099, 11, 31, 7, 0),
      wait: { by: "later", text: "Dec 31 2099 4PM" },
    },
  ]);
  assert.deepEqual((await lab.cardd.board()).holds, []);
  assert.deepEqual(await lab.answered(ship), []);
});

test("text with no time stays on the Later row with the refusal, records nothing, and a time then holds it", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", SHIP, "Later…"]));
  await lab.herdr().press(pane, "down", "down", "down");
  await lab.herdr().type(pane, "after the demo");
  await lab.herdr().press(pane, "enter");
  keep(
    "later-5-refused",
    await lab.screenWhere(
      pane,
      "the refusal with his words kept",
      onCard([`No time in "after the demo"`, "→ after the demo", "⏎ hold"]),
    ),
  );
  assert.deepEqual(await captainHolds(ship), []);
  assert.equal((await lab.cardd.board()).holds.length, 1, "it still waits for him");

  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the words cleared", onCard(["→ Later…", "type until when"]));
  await lab.herdr().type(pane, "in 2 hours");
  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  const [only, ...more] = await captainHolds(ship);
  assert.equal(more.length, 0);
  assert.deepEqual(only?.wait, { by: "later", text: "in 2 hours" });
  assert.ok(
    typeof only.until === "number" && Math.abs(only.until - (Date.now() + 2 * 3_600_000)) < 120_000,
    `held about 2 hours ahead: ${String(only.until)}`,
  );
});

test("a zone the reader does not know stays on the Later row with what to use, records nothing, and a zone he names holds with the time it reads", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", SHIP, "Later…"]));
  await lab.herdr().press(pane, "down", "down", "down");
  await lab.herdr().type(pane, "Dec 31 2099 4PM CHT");
  await lab.herdr().press(pane, "enter");
  keep(
    "later-7-zone-refused",
    await lab.screenWhere(
      pane,
      "the zone refusal with his words kept",
      onCard(["CHT is not a time zone the reader knows", "→ Dec 31 2099 4PM CHT", "⏎ hold"]),
    ),
  );
  assert.deepEqual(await captainHolds(ship), []);
  assert.equal((await lab.cardd.board()).holds.length, 1, "it still waits for him");

  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the words cleared", onCard(["→ Later…", "type until when"]));
  await lab.herdr().type(pane, "Dec 31 2099 4PM GMT+abc");
  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(
    pane,
    "the refusal of the part of the zone it cannot read, with his words kept",
    onCard(["GMT+abc is not a time zone the reader knows", "→ Dec 31 2099 4PM GMT+abc"]),
  );
  assert.deepEqual(await captainHolds(ship), []);

  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the words cleared again", onCard(["→ Later…", "type until when"]));
  await lab.herdr().type(pane, "Dec 31 2099 4PM CET");
  await lab.herdr().press(pane, "enter");
  keep(
    "later-8-zone-held",
    await lab.screenWhere(
      pane,
      "the card to close with the time and zone it reads",
      (screen) =>
        cardRows(screen).length === 0 &&
        showing([
          `c-${String(ship.id)} comes back to you Thu, Dec 31, 2099, 4:00 PM GMT+1 (Europe/Paris)`,
        ])(screen),
    ),
  );
  assert.deepEqual(await captainHolds(ship), [
    {
      until: Date.UTC(2099, 11, 31, 15, 0),
      wait: { by: "later", text: "Dec 31 2099 4PM CET" },
    },
  ]);
});

test("every kind of decision keeps his own words and Later: one with options, one with none, and a merge question", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const bare = await lab.askedMain(pane, "Lane name", LANE_ASK, [], 2);
  const merge = await mergeAskedMain(pane, 3);
  lab.answers(3);

  await lab.herdr().submit(pane, "/d");
  const kinds: [Card, string, string[], string[]][] = [
    [ship, SHIP, ["Ship it", "Hold"], ["Approve & merge"]],
    [bare, LANE_ASK, [], ["Ship it", "Approve & merge"]],
    [merge, MERGE_ASK, [...MERGE_OPTIONS], ["Ship it"]],
  ];
  for (const [at, [card, question, options, absent]] of kinds.entries()) {
    const shown = await lab.screenWhere(
      pane,
      `decision ${String(at + 1)}`,
      onCard(
        [`Decision ${String(at + 1)} of 3`, question, ...options, "My words…", "Later…"],
        absent,
      ),
    );
    keep(`later-6-kind-${String(at + 1)}`, shown);
    await lab.herdr().type(pane, `${MY_WORDS} ${String(card.id)}`);
    await lab.herdr().press(pane, "enter");
    await lab.screenWhere(pane, "the next decision or the closed card", (screen) =>
      at === 2
        ? cardRows(screen).length === 0
        : onCard([`Decision ${String(at + 2)} of 3`])(screen),
    );
    assert.deepEqual(await lab.answered(card), [
      { body: `${MY_WORDS} ${String(card.id)}`, source: "pane", written: true },
    ]);
  }
});
