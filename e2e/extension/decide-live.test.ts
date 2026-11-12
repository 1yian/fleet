import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  awaiting,
  cardRows,
  DecideLab,
  keep,
  NOTHING,
  onCard,
  RENAME,
  SHIP,
  showing,
} from "../support/decide-lab.ts";

const CLEAR = "board";
const REWRITTEN = "Ship it only after the audit?";
const NEW_ONE = "A new decision is on screen. Read it, then press ⏎.";
const CHANGED = "changed. Read it, then press ⏎.";

let lab: DecideLab;
beforeEach(async () => {
  lab = await DecideLab.start({ FLEET_PANE_LIVE_MS: "500" });
});
afterEach(async (t) => {
  await lab.stop(t);
});

const waitingCards = async (): Promise<number[]> =>
  (await lab.cardd.board()).holds.map((hold) => hold.card);

test("/d with nothing waiting stays open, and a decision shows on it by itself when main puts it to him", async () => {
  const pane = await lab.openMain();
  await lab.screenWhere(pane, "main to read the board", showing([CLEAR]));
  await lab.h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");

  await lab.herdr().submit(pane, "/d");
  keep("live-1-nothing", await lab.screenWhere(pane, "the card on nothing", onCard([NOTHING])));
  assert.deepEqual(await waitingCards(), []);

  const ship = await lab.askedUnseen("Scrollbar fix", SHIP, ["Ship it", "Hold"]);
  const arrived = await lab.screenWhere(
    pane,
    "the decision to arrive on the open card",
    onCard(["Decision 1 of 1", SHIP, "Ship it", "Hold", NEW_ONE], [NOTHING]),
  );
  keep("live-2-arrived", arrived);
  assert.deepEqual(await waitingCards(), [ship.id]);
  await lab.screenWhere(pane, "the bar to count it too", showing([awaiting(1)]));

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the first ⏎ to be a look", onCard([SHIP], [NEW_ONE]));
  assert.deepEqual(await lab.answered(ship), []);

  lab.answers(1);
  await lab.herdr().press(pane, "enter");
  await lab.mainWasTold(2, ship, "Ship it");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(ship), [
    { body: "Ship it", source: "pane", written: undefined },
  ]);
});

test("a card that is answered and then asked again, by its second mate through main, is open again in its place on the card, three times in a row", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the first decision", onCard(["Decision 1 of 2", SHIP]));

  let calls = 4;
  for (const round of [1, 2, 3]) {
    lab.answers(1);
    await lab.herdr().press(pane, "enter");
    await lab.mainWasTold(calls, ship, round === 1 ? "Ship it" : "Hold");
    calls += 1;
    await lab.screenWhere(
      pane,
      `the card on the second decision after answer ${String(round)}`,
      onCard(["Decision 2 of 2", RENAME]),
    );
    assert.deepEqual(await waitingCards(), [rename.id]);

    const question = `${SHIP} Round ${String(round + 1)}.`;
    await lab.askedAgain(ship, question, ["Hold", "Ship it"]);
    calls += 2;
    await lab.screenWhere(pane, "the bar to count both again", showing([awaiting(2)]));
    await lab.herdr().press(pane, "left");
    const again = await lab.screenWhere(
      pane,
      `round ${String(round + 1)} in place of the answered slot`,
      onCard(["Decision 1 of 2", question], [RENAME]),
    );
    keep(`live-3-asked-again-${String(round)}`, again);
    assert.equal((await waitingCards()).length, 2);
  }
  assert.equal((await lab.answered(ship)).length, 3);
});

test("a decision that its mate rewrites while the card is open replaces the old one in place, and the first ⏎ after it answers nothing", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", SHIP], [REWRITTEN]));

  await lab.cleo.call("hold", {
    card: ship.id,
    question: REWRITTEN,
    options: ["Ship it", "Hold"],
  });
  const rewritten = await lab.screenWhere(
    pane,
    "the rewritten question",
    onCard(["Decision 1 of 1", REWRITTEN, CHANGED], [SHIP]),
  );
  keep("live-5-rewritten", rewritten);

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the first ⏎ to be taken as a look", onCard([REWRITTEN], [CHANGED]));
  assert.deepEqual(await lab.answered(ship), []);
  assert.deepEqual(await waitingCards(), [ship.id]);

  lab.answers(1);
  await lab.herdr().press(pane, "enter");
  await lab.mainWasTold(2, ship, "Ship it");
  assert.deepEqual(await lab.answered(ship), [
    { body: "Ship it", source: "pane", written: undefined },
  ]);
});

const putOff = async (card: number): Promise<number> => {
  const open = (await lab.cardd.board()).holds.find((hold) => hold.card === card);
  assert.ok(open !== undefined, `c-${String(card)} is held for the captain`);
  return lab.cardd.act(card, { kind: "hold", hold: open.hold, said: "in 2 hours", zone: "UTC" });
};

test("a decision put off while it is on screen leaves the card for the next one, and the first ⏎ after it answers nothing", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the first decision", onCard(["Decision 1 of 2", SHIP]));
  lab.answers(3);

  assert.equal(await putOff(ship.id), 200);
  keep(
    "live-8-put-off-on-screen",
    await lab.screenWhere(
      pane,
      "the next decision and why it is there",
      onCard(["Decision 1 of 1", NEW_ONE, RENAME], [SHIP]),
    ),
  );

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the first ⏎ to be a look", onCard([RENAME], [NEW_ONE]));
  assert.deepEqual(await lab.answered(ship), []);
  assert.deepEqual(await lab.answered(rename), []);

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the answer", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(rename), [
    { body: "Rename", source: "pane", written: undefined },
  ]);
  assert.deepEqual(await lab.answered(ship), []);
});

test("a decision he puts off on the board leaves the open card and the status bar together", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "both decisions", onCard(["Decision 1 of 2", SHIP]));

  assert.equal(await putOff(rename.id), 200);
  const left = await lab.screenWhere(
    pane,
    "the put-off decision to leave the card and the bar",
    (screen) =>
      onCard(["Decision 1 of 1", SHIP], [RENAME])(screen) && showing([awaiting(1)])(screen),
  );
  keep("live-6-put-off-while-open", left);
  assert.deepEqual(await waitingCards(), [ship.id]);
});

test("a decision put off while the card is closed is gone from /d and from the bar together the moment /d opens", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  assert.equal(await putOff(rename.id), 200);
  assert.deepEqual(await waitingCards(), [ship.id]);

  await lab.herdr().submit(pane, "/d");
  const agreed = await lab.screenWhere(
    pane,
    "/d and the bar to count the same one decision",
    (screen) =>
      onCard(["Decision 1 of 1", SHIP], [RENAME])(screen) && showing([awaiting(1)])(screen),
  );
  keep("live-7-bar-and-card-agree", agreed);
});
