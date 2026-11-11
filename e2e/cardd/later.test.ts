import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  ActedSchema,
  CardViewSchema,
  check,
  MERGE_OPTIONS,
  OPS,
  type Card,
  type Entry,
} from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

const QUESTION = "Renew the certificate?";
const OPTIONS = ["Now", "Next week"];
const MINUTE = 60_000;
const EXAMPLES = "tomorrow, Friday 4PM, 4PM CST, Nov 20, or in 2 hours";
const PR = "https://github.com/acme/web/pull/7";

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet();
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await Promise.allSettled([cleo.close()]);
  await fleet.cardd.stop();
});

async function asked(title: string): Promise<Card> {
  const card = await newCard(fleet.main, title, "captain");
  await fleet.main.call("hold", { card: card.id, question: QUESTION, options: OPTIONS });
  return card;
}

const entries = async (card: Card): Promise<Entry[]> => (await fleet.cardd.thread(card.id)).entries;
const holds = async (card: Card): Promise<Entry[]> =>
  (await entries(card)).filter((entry) => entry.kind === "hold");
const needsYou = async (): Promise<number[]> =>
  (await fleet.cardd.board()).holds.map((hold) => hold.card);

async function holdOf(card: Card): Promise<number> {
  const view = check(CardViewSchema, await fleet.main.call("card", { card: card.id }));
  if (view.hold === null) throw new Error(`c-${String(card.id)} has no hold`);
  return view.hold.entry;
}

async function fromBoard(card: Card, said: string, zone: string) {
  return fleet.cardd.refusal(card.id, { kind: "hold", hold: await holdOf(card), said, zone });
}

async function fromPane(card: Card, said: string, zone: string) {
  const args = { card: card.id, hold: await holdOf(card), said, zone };
  return check(OPS["pane.later"].result, await fleet.main.call("pane.later", args));
}

async function untilOf(said: string, zone: string): Promise<number> {
  const card = await asked(`Read ${said} in ${zone}`);
  return (await fromPane(card, said, zone)).until;
}

test("a typed later holds the card as the captain's dated later, the same from the board and from the pane", async () => {
  const board = await asked("From the board");
  const pane = await asked("From the pane");
  const said = "Dec 31 2099 4PM CST";
  const until = Date.UTC(2099, 11, 31, 22, 0);

  const acted = await fromBoard(board, said, "UTC");
  assert.equal(acted.status, 200);
  assert.deepEqual(check(ActedSchema, acted.body).later, { until, zone: "America/Chicago" });
  const result = await fromPane(pane, said, "UTC");
  assert.deepEqual([result.until, result.zone], [until, "America/Chicago"]);

  for (const card of [board, pane]) {
    const hold = (await holds(card)).at(-1);
    assert.equal(hold?.author, "captain");
    assert.equal(hold.body, QUESTION);
    assert.equal(hold.fields["until"], until);
    assert.deepEqual(hold.fields["wait"], { by: "later", text: said });
    assert.deepEqual(hold.fields["options"], OPTIONS);
    assert.equal(await status(fleet.main, card), "waiting");
    const shown = (await fleet.cardd.board()).cards.find((each) => each.id === card.id);
    assert.deepEqual(shown?.datedWait && { ...shown.datedWait, since: 0 }, {
      until,
      since: 0,
      watch: "later",
      what: said,
    });
  }
  assert.deepEqual(await needsYou(), []);
});

test("a bare time is read in the zone of the screen he typed on, a zone in his words wins, and a time already past today means the next one", async () => {
  const zones: [string, string, number][] = [
    ["Dec 31 2099 4PM", "America/Chicago", Date.UTC(2099, 11, 31, 22)],
    ["Dec 31 2099 4PM", "Asia/Tokyo", Date.UTC(2099, 11, 31, 7)],
    ["Dec 31 2099 4PM CST", "Asia/Tokyo", Date.UTC(2099, 11, 31, 22)],
    ["Jul 4 2099 4PM CST", "UTC", Date.UTC(2099, 6, 4, 21)],
    ["Jul 4 2099 4pm America/New_York", "UTC", Date.UTC(2099, 6, 4, 20)],
    ["Dec 31 2099 4:30 pm PST", "UTC", Date.UTC(2100, 0, 1, 0, 30)],
    ["2099-12-31 16:00", "Europe/Paris", Date.UTC(2099, 11, 31, 15)],
    ["12am Dec 31 2099 UTC", "Asia/Tokyo", Date.UTC(2099, 11, 31)],
  ];
  for (const [said, zone, expected] of zones)
    assert.equal(await untilOf(said, zone), expected, `${said} typed in ${zone}`);

  const now = Date.now();
  const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
  const twoMinutesAgo = new Date(now - 2 * MINUTE);
  const ahead = new Date(now + 120 * MINUTE);
  const sameTomorrow = Date.UTC(
    twoMinutesAgo.getUTCFullYear(),
    twoMinutesAgo.getUTCMonth(),
    twoMinutesAgo.getUTCDate() + 1,
    twoMinutesAgo.getUTCHours(),
    twoMinutesAgo.getUTCMinutes(),
  );
  assert.equal(await untilOf(`${clock(now - 2 * MINUTE)} UTC`, "Asia/Tokyo"), sameTomorrow);
  const nextTime = Date.UTC(
    ahead.getUTCFullYear(),
    ahead.getUTCMonth(),
    ahead.getUTCDate(),
    ahead.getUTCHours(),
    ahead.getUTCMinutes(),
  );
  assert.equal(await untilOf(`${clock(now + 120 * MINUTE)} UTC`, "Asia/Tokyo"), nextTime);
});

test("the words he types read as a day, a weekday, a date, or a time ahead", async () => {
  const phrases = [
    "tomorrow",
    "Friday",
    "Friday 4PM",
    "4PM CST",
    "Nov 20",
    "20th of November 9am",
    "in 2 hours",
    "in a day",
    "I have not run it. Snooze until 4PM CST",
  ];
  for (const said of phrases) {
    const before = Date.now();
    const until = await untilOf(said, "America/Chicago");
    assert.ok(until > before, `${said} is ahead of now`);
    assert.ok(until < before + 400 * 24 * 60 * MINUTE, `${said} is within a year`);
  }
  const first = Date.now();
  const hours = (await untilOf("in 2 hours", "UTC")) - first;
  assert.ok(Math.abs(hours - 120 * MINUTE) < MINUTE, `in 2 hours is ${String(hours)}ms ahead`);
});

test("text with no time is refused in place, with what he can say, and nothing is recorded", async () => {
  const card = await asked("Unreadable");
  const before = await entries(card);
  const said = "after the demo";

  const refusal = await fromBoard(card, said, "UTC");
  assert.equal(refusal.status, 400);
  const error = refusal.error ?? "";
  assert.ok(error.includes(`No time in "${said}"`), error);
  assert.ok(error.includes(EXAMPLES), error);
  await assert.rejects(fromPane(card, said, "UTC"), {
    message: new RegExp(`No time in "${said}".*${EXAMPLES}`),
  });

  const refused: [string, RegExp][] = [
    ["Jan 1 2020", /in the past/],
    ["Feb 30 2099", /not a date that exists/],
    ["tomorrow or Friday", /names two days/],
    ["2pm or 3pm", /names two times/],
    ["in 2 hours at 4pm", /both a time ahead and a time of day/],
    ["in 0 hours", /no time ahead/],
    ["25:00", /not a time of day/],
    ["4pm America/Nowhere", /not an IANA time zone/],
  ];
  for (const [text, message] of refused) {
    const outcome = await fromBoard(card, text, "UTC");
    assert.equal(outcome.status, 400, text);
    assert.match(outcome.error ?? "", message, text);
  }
  const outcome = await fromBoard(card, "9am", "Mars/Base");
  assert.match(outcome.error ?? "", /not an IANA time zone/);

  assert.deepEqual(await entries(card), before);
  assert.deepEqual(await needsYou(), [card.id]);
  assert.equal(await status(fleet.main, card), "needs-you");
});

test("the card leaves his list and returns by itself at the time he typed", async () => {
  const card = await asked("Back soon");
  const said = "in 2 seconds";
  assert.equal((await fromBoard(card, said, "UTC")).status, 200);
  assert.deepEqual(await needsYou(), []);
  assert.equal(await status(fleet.main, card), "waiting");

  await until(async () => ((await needsYou()).includes(card.id) ? true : undefined), "its return");
  assert.equal(await status(fleet.main, card), "needs-you");
  const [back, ...rest] = (await fleet.cardd.board()).holds;
  assert.equal(rest.length, 0);
  assert.deepEqual([back?.question, back?.options], [QUESTION, OPTIONS]);
});

test("only the captain's pane or board can put his decision off: a second mate, a worker, and main's own hold are refused", async () => {
  const card = await asked("Not for agents");
  const worker = await fleet.cardd.connect(await begin(cleo, await newCard(cleo, "Cleo's card")));
  const args = { card: card.id, hold: await holdOf(card), said: "tomorrow", zone: "UTC" };

  await assert.rejects(cleo.call("pane.later", args), {
    message: /only main's pane takes the captain's later/,
  });
  await assert.rejects(worker.call("pane.later", args), {
    message: "worker sessions cannot call pane.later",
  });
  const until = Date.now() + 60 * MINUTE;
  const invented = { card: card.id, question: QUESTION, until, remaining: [], source: "record" };
  await assert.rejects(fleet.main.call("hold", { ...invented, said: "snooze it until Friday" }), {
    message: /not in the captain's messages or board entries/,
  });
  await assert.rejects(cleo.call("hold", { ...invented, said: "snooze it until Friday" }), {
    message: /reach|not in your lane|belongs to lane/,
  });

  const mates = await newCard(cleo, "Held by its mate");
  await cleo.call("hold", { card: mates.id, question: "Which plan?", options: ["A", "B"] });
  await assert.rejects(fromPane(mates, "tomorrow", "UTC"), {
    message: /that hold is with main or its mate/,
  });

  assert.deepEqual(await needsYou(), [card.id]);
  assert.equal(await status(fleet.main, card), "needs-you");
  for (const each of [card, mates])
    assert.deepEqual(
      (await holds(each)).filter((hold) => hold.author === "captain"),
      [],
      `no captain hold was written on c-${String(each.id)}`,
    );
});

test("a later on a decision that changed since the captain looked is refused, and one on the current decision is taken", async () => {
  const card = await asked("Changed meanwhile");
  const seen = await holdOf(card);
  await fleet.main.call("hold", { card: card.id, question: "Renew it today?", options: ["Yes"] });
  const args = { card: card.id, hold: seen, said: "tomorrow", zone: "UTC" };
  await assert.rejects(fleet.main.call("pane.later", args), {
    message: /decision changed, so nothing was recorded/,
  });
  assert.equal((await fromBoard(card, "tomorrow", "UTC")).status, 200);
});

test("a merge question put off comes back as the same merge question with its own options", async () => {
  const card = await newCard(cleo, "Ads exports");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "PR ready", pr: PR });
  await fleet.main.waitForEntry((entry) => entry.kind === "hold", "the merge hold");
  await fleet.main.call("hold", { card: card.id, to: "captain", question: `Merge ${PR}?` });
  assert.deepEqual(await needsYou(), [card.id]);

  assert.equal((await fromBoard(card, "in 2 seconds", "UTC")).status, 200);
  assert.deepEqual(await needsYou(), []);
  await until(async () => ((await needsYou()).includes(card.id) ? true : undefined), "its return");
  const [back] = (await fleet.cardd.board()).holds;
  assert.deepEqual(
    [back?.question, back?.merge, back?.options],
    [`Merge ${PR}?`, true, [...MERGE_OPTIONS]],
  );
});
