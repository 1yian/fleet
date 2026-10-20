// Lane cards and one way to talk to an agent: comment on its card (spec sections 6.3, 10, and 16),
// against a real cardd on a scratch database with scratch lanes.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let leo: Session;
beforeEach(async () => {
  fleet = await startFleet();
  leo = await fleet.cardd.connect(fleet.cardd.addLane("leo", "main"));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const cards = async (mate: Session): Promise<Card[]> =>
  check(OPS.board.result, await mate.call("board", {}));
const laneCardOf = async (lane: string): Promise<Card> => {
  const card = (await cards(fleet.main)).find(
    (each) => each.kind === "standing" && each.lane === lane,
  );
  assert.ok(card, `lane ${lane} has a lane card`);
  return card;
};
const words = (session: Session): [string, string, string | undefined][] =>
  session.entries.map(({ entry }: { entry: Entry }) => [
    entry.author,
    entry.body,
    typeof entry.fields["re"] === "string" ? entry.fields["re"] : undefined,
  ]);

/** The Leo c-8 case: leo's card has a worker, and the captain has a follow-up for it. */
async function leoCardWithWorker(): Promise<{ card: Card; worker: Session }> {
  const card = await newCard(leo, "Credit the test account", "ship");
  const worker = await fleet.cardd.connect(await begin(leo, card, "credit the account"));
  await worker.waitForEntries(1);
  return { card, worker };
}

test("every second mate has an open lane card, and main has none", async () => {
  const lane = await laneCardOf("leo");
  assert.deepEqual([lane.title, lane.status], ["leo", "waiting"]);
  assert.equal((await cards(fleet.main)).filter((card) => card.kind === "standing").length, 1);
});

test("a lane card stays open: it cannot be dispatched, held, or closed", async () => {
  const lane = await laneCardOf("leo");
  const dispatch = { card: lane.id, host: "maverick", task: "x" };
  await assert.rejects(leo.call("attempt.begin", dispatch), /lane card of leo/);
  await assert.rejects(fleet.main.call("attempt.begin", dispatch), {
    message: `c-${String(lane.id)} belongs to lane leo`,
  });
  await assert.rejects(
    leo.call("hold", { card: lane.id, question: "x?", options: ["a"] }),
    /lane card of leo/,
  );
  for (const mode of ["done", "dropped"]) {
    await assert.rejects(leo.call("close.begin", { card: lane.id, mode }), /lane card of leo/);
    await assert.rejects(
      fleet.main.call("close.begin", { card: lane.id, mode }),
      /lane card of leo/,
    );
  }
  assert.equal(await status(fleet.main, lane), "waiting");
});

test("main's card_new in a second mate's lane is refused, and points at the lane card", async () => {
  const before = (await cards(fleet.main)).length;
  await assert.rejects(
    fleet.main.call("card.new", { title: "Credit the test account", kind: "ship", lane: "leo" }),
    {
      message:
        'card_new cannot create a card in lane leo. To hand work to leo, comment on its lane card: comment(lane="leo", text=...). It creates its own card.',
    },
  );
  await assert.rejects(leo.call("card.new", { title: "x", kind: "scout", lane: "main" }), {
    message:
      "card_new cannot create a card in lane main. A mate creates cards only in its own lane.",
  });
  assert.equal((await cards(fleet.main)).length, before);

  const own = check(
    CardSchema,
    await fleet.main.call("card.new", { title: "Main's own", kind: "scout", lane: "main" }),
  );
  assert.equal(own.lane, "main");
});

test("main hands work to a second mate with a comment on its lane card", async () => {
  await fleet.main.call("comment", {
    lane: "leo",
    text: "The captain wants the test account credited",
  });

  const heard = await leo.waitForEntry((entry) => entry.author === "mate:main", "main's comment");
  assert.equal(heard.body, "The captain wants the test account credited");
  assert.equal(heard.card, (await laneCardOf("leo")).id);
});

test("one comment carries the captain's follow-up to the lane mate, whatever the card status", async () => {
  const { card, worker } = await leoCardWithWorker();
  assert.equal(await status(fleet.main, card), "working");

  await fleet.main.call("comment", {
    card: card.id,
    text: "Captain: it can make an account with that password tho",
  });
  const heard = await leo.waitForEntry((entry) => entry.author === "mate:main", "the follow-up");
  assert.equal(heard.card, card.id);
  assert.equal(await status(fleet.main, card), "working");

  // The mate decides what its worker hears. The worker never hears main.
  await leo.call("comment", { card: card.id, text: "Create the account with that password" });
  await worker.waitForEntries(2);
  assert.deepEqual(
    worker.entries.map(({ entry }) => entry.author),
    ["mate:leo", "mate:leo"],
  );

  // Even with the card With mate, main's comment changes nothing but who hears it.
  await worker.call("report", { status: "blocked", text: "stuck" });
  assert.equal(await status(fleet.main, card), "with-mate");
  await fleet.main.call("comment", { card: card.id, text: "Never mind the password" });
  await leo.waitForEntry((entry) => entry.body === "Never mind the password", "the second comment");
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("the mate's next action reaches main once, with main's comment", async () => {
  const { card } = await leoCardWithWorker();
  await fleet.main.call("comment", { card: card.id, text: "Use the test account" });
  await leo.waitForEntries(1);

  await leo.call("comment", { card: card.id, text: "Steered the worker" });
  await leo.call("comment", { card: card.id, text: "Second steer" });
  await fleet.main.waitForEntries(1);
  await fleet.main.call("board", {});
  assert.deepEqual(words(fleet.main), [["mate:leo", "Steered the worker", "Use the test account"]]);
});

test("a second mate's comment on its lane card reaches main", async () => {
  await leo.call("comment", { lane: "leo", text: "I can answer this from my records: yes" });
  const heard = await fleet.main.waitForEntry((entry) => entry.author === "mate:leo", "the answer");
  assert.equal(heard.body, "I can answer this from my records: yes");
  assert.equal(heard.card, (await laneCardOf("leo")).id);

  const lane = await laneCardOf("leo");
  await leo.call("comment", { card: lane.id, text: "Same, by number" });
  await fleet.main.waitForEntries(2);
  assert.equal(await status(fleet.main, lane), "waiting");
});

test("main's comment and the mate's reply on the lane card echo once", async () => {
  await fleet.main.call("comment", { lane: "leo", text: "Can you credit the account?" });
  await leo.waitForEntries(1);
  await leo.call("comment", { lane: "leo", text: "Yes, done" });
  await leo.call("comment", { lane: "leo", text: "Anything else?" });
  await fleet.main.waitForEntries(2);
  assert.deepEqual(words(fleet.main), [
    ["mate:leo", "Yes, done", "Can you credit the account?"],
    ["mate:leo", "Anything else?", undefined],
  ]);
});

test("comments reach only the agent of the card's owner", async () => {
  const lane = await laneCardOf("leo");
  const own = await newCard(fleet.main, "Main's own card");
  await assert.rejects(leo.call("comment", { card: own.id, text: "hi" }), {
    message: `c-${String(own.id)} belongs to lane main`,
  });
  await assert.rejects(leo.call("comment", { lane: "main", text: "hi" }), {
    message: "lane main is not your lane or one of your second mates",
  });
  await assert.rejects(fleet.main.call("comment", { lane: "main", text: "hi" }), {
    message: "lane main has no lane card",
  });
  await assert.rejects(fleet.main.call("comment", { text: "hi" }), {
    message: "comment needs either card or lane, and not both",
  });
  await assert.rejects(fleet.main.call("comment", { card: lane.id, lane: "leo", text: "hi" }), {
    message: "comment needs either card or lane, and not both",
  });
  await assert.rejects(
    fleet.main.call("comment", { card: lane.id, text: "hi", resolves: "key" }),
    /only the mate of a card has one/,
  );
});

test("a comment that reached no worker is not echoed in the next report", async () => {
  const card = await newCard(leo, "Credit the test account", "ship");
  await leo.call("comment", { card: card.id, text: "Heads up before any worker exists" });
  const worker = await fleet.cardd.connect(await begin(leo, card, "the task"));
  await worker.call("report", { status: "working", text: "started" });
  await worker.call("report", { status: "done", text: "finished" });
  await leo.waitForEntries(2);
  assert.deepEqual(
    leo.entries.map(({ entry }) => [entry.body, entry.fields["re"]]),
    [
      ["started", "the task"],
      ["finished", undefined],
    ],
  );
});
