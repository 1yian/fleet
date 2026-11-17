import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let cleo: Session;
let worker: Session;
let workerCard: number;
beforeEach(async () => {
  fleet = await startFleet();
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(fleet.main, "Users see one scrollbar");
  workerCard = card.id;
  worker = await fleet.cardd.connect(await begin(fleet.main, card));
});
afterEach(async () => {
  await Promise.allSettled([cleo.close(), worker.close()]);
  await fleet.cardd.stop();
});

const listed = async (who: Session, limit?: number) =>
  check(OPS.complaints.result, await who.call("complaints", limit === undefined ? {} : { limit }));

test("cardd attributes a complaint from the session, redacts secrets, and refuses long or blank text", async () => {
  await worker.call("complain", {
    text: "The setup said token=abc123secret and Bearer abcdefghijklmnop.qrstuv to me.",
    card: 999,
  });
  assert.deepEqual(
    (await listed(fleet.main)).map(({ at, ...kept }) => ({ ...kept, timed: at > 0 })),
    [
      {
        id: 1,
        session: `c-${String(workerCard)}-a1`,
        role: "worker",
        lane: "main",
        card: workerCard,
        project: "web",
        text: "The setup said token=[hidden] and [hidden] to me.",
        timed: true,
      },
    ],
  );
  await assert.rejects(
    worker.call("complain", { text: "x".repeat(501) }),
    /more than 500 characters/,
  );
  await assert.rejects(worker.call("complain", { text: "   " }), /invalid \/text/);
  assert.equal((await listed(fleet.main)).length, 1);
});

test("a mate can attribute only visible cards, while main can attribute every lane", async () => {
  const own = await newCard(cleo, "Cleo's own card");
  await cleo.call("complain", { text: "Closing a card is slow.", card: own.id });
  await cleo.call("complain", { text: "Foreign card feedback.", card: workerCard });
  await cleo.call("complain", { text: "The board header is noisy.", card: 999 });
  await cleo.call("complain", { text: "Dispatch has too many arguments." });

  assert.deepEqual(
    (await listed(cleo)).map(({ id, card, project, session, role, lane }) => [
      id,
      card,
      project,
      session,
      role,
      lane,
    ]),
    [
      [4, null, null, "cleo", "mate", "cleo"],
      [3, null, null, "cleo", "mate", "cleo"],
      [2, null, null, "cleo", "mate", "cleo"],
      [1, own.id, "web", "cleo", "mate", "cleo"],
    ],
  );
  await fleet.main.call("complain", { text: "Main can see Cleo's card.", card: own.id });
  const latest = (await listed(fleet.main))[0];
  assert.equal(latest?.card, own.id);
  assert.equal(latest.project, "web");
});

test("main reads every lane's complaints and a second mate only its own, newest first, within the limit", async () => {
  await worker.call("complain", { text: "One." });
  await cleo.call("complain", { text: "Two." });
  await fleet.main.call("complain", { text: "Three." });

  assert.deepEqual(
    (await listed(fleet.main)).map(({ text, lane }) => [text, lane]),
    [
      ["Three.", "main"],
      ["Two.", "cleo"],
      ["One.", "main"],
    ],
  );
  assert.deepEqual(
    (await listed(fleet.main, 2)).map(({ text }) => text),
    ["Three.", "Two."],
  );
  assert.deepEqual(
    (await listed(cleo)).map(({ text }) => text),
    ["Two."],
  );
  await assert.rejects(worker.call("complaints", {}), /worker sessions cannot call complaints/);
});
