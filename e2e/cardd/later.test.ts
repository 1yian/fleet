import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ActedSchema, CardViewSchema, check, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";
import { tempDir } from "../support/run-root.ts";

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

const unknownZone = (token: string): RegExp =>
  new RegExp(
    `${token.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is not a time zone the reader knows\\. Use a city such as Europe/Paris, an offset such as UTC\\+2, or one of ET, CT, MT, PT\\.`,
  );

async function readDate(said: string, zone: string) {
  const card = await asked(`Read ${said} in ${zone}`);
  const acted = await fromBoard(card, said, zone);
  assert.equal(acted.status, 200, `${said}: ${acted.error ?? ""}`);
  const result = check(ActedSchema, acted.body).later;
  assert.ok(result, `${said}: the board action says what it read`);
  return result;
}

async function untilOf(said: string, zone: string): Promise<number> {
  return (await readDate(said, zone)).until;
}

test("a typed later holds the card as the captain's dated later from the board", async () => {
  const board = await asked("From the board");
  const said = "Dec 31 2099 4PM CST";
  const until = Date.UTC(2099, 11, 31, 22, 0);

  const acted = await fromBoard(board, said, "UTC");
  assert.equal(acted.status, 200);
  assert.deepEqual(check(ActedSchema, acted.body).later, { until, zone: "America/Chicago" });
  for (const card of [board]) {
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

test("a zone in his words wins however he names it: an abbreviation, an offset, or a city from the board", async () => {
  const named: [string, string, number, string][] = [
    ["Dec 31 2099 4PM CET", "UTC", Date.UTC(2099, 11, 31, 15), "Europe/Paris"],
    ["Jul 4 2099 4PM CEST", "UTC", Date.UTC(2099, 6, 4, 14), "Europe/Paris"],
    ["Dec 31 2099 4PM EET", "UTC", Date.UTC(2099, 11, 31, 14), "Europe/Athens"],
    ["Jul 4 2099 4PM EEST", "UTC", Date.UTC(2099, 6, 4, 13), "Europe/Athens"],
    ["Dec 31 2099 4PM WET", "UTC", Date.UTC(2099, 11, 31, 16), "Europe/Lisbon"],
    ["Jul 4 2099 4PM WEST", "UTC", Date.UTC(2099, 6, 4, 15), "Europe/Lisbon"],
    ["Jul 4 2099 4PM BST", "Asia/Tokyo", Date.UTC(2099, 6, 4, 15), "Europe/London"],
    ["Dec 31 2099 4PM JST", "UTC", Date.UTC(2099, 11, 31, 7), "Asia/Tokyo"],
    ["Dec 31 2099 4PM KST", "UTC", Date.UTC(2099, 11, 31, 7), "Asia/Seoul"],
    ["Jul 4 2099 4PM AEST", "UTC", Date.UTC(2099, 6, 4, 6), "Australia/Sydney"],
    ["Dec 31 2099 4PM AEST", "UTC", Date.UTC(2099, 11, 31, 5), "Australia/Sydney"],
    ["Dec 31 2099 4PM AEDT", "UTC", Date.UTC(2099, 11, 31, 5), "Australia/Sydney"],
    ["Jul 4 2099 4PM NZST", "UTC", Date.UTC(2099, 6, 4, 4), "Pacific/Auckland"],
    ["Dec 31 2099 4PM NZDT", "UTC", Date.UTC(2099, 11, 31, 3), "Pacific/Auckland"],
    ["Jul 4 2099 4PM CST", "UTC", Date.UTC(2099, 6, 4, 21), "America/Chicago"],
    ["Dec 31 2099 4PM UTC+2", "UTC", Date.UTC(2099, 11, 31, 14), "+02:00"],
    ["Dec 31 2099 4:05PM UTC", "Asia/Tokyo", Date.UTC(2099, 11, 31, 16, 5), "UTC"],
    ["Dec 31 2099 4PM IN CET", "UTC", Date.UTC(2099, 11, 31, 15), "Europe/Paris"],
    ["Dec 31 2099 4 PM CET", "UTC", Date.UTC(2099, 11, 31, 15), "Europe/Paris"],
    ["Dec 31 2099 4PM cet", "UTC", Date.UTC(2099, 11, 31, 15), "Europe/Paris"],
    ["Snooze until Dec 31 2099 4PM CST.", "UTC", Date.UTC(2099, 11, 31, 22), "America/Chicago"],
    ["(Dec 31 2099, 4PM CET)", "UTC", Date.UTC(2099, 11, 31, 15), "Europe/Paris"],
    ["Dec 31 2099 4 p.m. CET.", "UTC", Date.UTC(2099, 11, 31, 15), "Europe/Paris"],
    ["Dec 31 2099 4PM and constructor", "UTC", Date.UTC(2099, 11, 31, 16), "UTC"],
    [
      "I have not run it. Snooze until Dec 31 2099 4PM CST - thanks",
      "UTC",
      Date.UTC(2099, 11, 31, 22),
      "America/Chicago",
    ],
    ["Dec 31 2099 4PM GMT-5", "Asia/Tokyo", Date.UTC(2099, 11, 31, 21), "-05:00"],
    ["Dec 31 2099 4PM GMT-3:30", "UTC", Date.UTC(2099, 11, 31, 19, 30), "-03:30"],
    ["Dec 31 2099 4PM UTC+14", "UTC", Date.UTC(2099, 11, 31, 2), "+14:00"],
    ["Dec 31 2099 4PM UTC-12", "UTC", Date.UTC(2100, 0, 1, 4), "-12:00"],
    ["Dec 31 2099 4PM +05:30", "UTC", Date.UTC(2099, 11, 31, 10, 30), "+05:30"],
    ["2099-12-31 16:00 -08:00", "UTC", Date.UTC(2100, 0, 1, 0), "-08:00"],
    ["Dec 31 2099 4PM Europe/Paris", "UTC", Date.UTC(2099, 11, 31, 15), "Europe/Paris"],
    ["Jul 4 2099 4PM west coast", "UTC", Date.UTC(2099, 6, 4, 16), "UTC"],
    ["Dec 31 2099 4PM Canada/Eastern", "UTC", Date.UTC(2099, 11, 31, 21), "America/Toronto"],
    ["Dec 31 2099 4PM US/Pacific", "UTC", Date.UTC(2100, 0, 1, 0), "America/Los_Angeles"],
    ["Dec 31 2099 4PM Etc/GMT-5", "UTC", Date.UTC(2099, 11, 31, 11), "Etc/GMT-5"],
    ["Dec 31 2099 4PM UTC", "Asia/Tokyo", Date.UTC(2099, 11, 31, 16), "UTC"],
    ["in 2 hours UTC", "Asia/Tokyo", 0, "UTC"],
    ["Nov 1 2099 1:30am America/New_York", "UTC", Date.UTC(2099, 10, 1, 5, 30), "America/New_York"],
  ];
  for (const [said, screen, until, zone] of named) {
    const before = Date.now();
    const read = await readDate(said, screen);
    for (const [surface, result] of [["board", read]] as const) {
      const where = `${said} from the ${surface} on a ${screen} screen`;
      assert.equal(result.zone, zone, where);
      if (until === 0) assert.ok(Math.abs(result.until - before - 120 * MINUTE) < MINUTE, where);
      else assert.equal(result.until, until, where);
    }
  }
});

async function pinnedAt(iso: string): Promise<void> {
  await Promise.allSettled([cleo.close()]);
  await fleet.cardd.stop();
  const dir = tempDir("later-clock-");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "clock");
  writeFileSync(file, iso);
  fleet = await startFleet({ CARDD_CLOCK_FILE: file });
}

async function yearless(said: string, zone = "UTC"): Promise<number> {
  const read = await readDate(said, zone);
  return read.until;
}

test("a date with no year is its next occurrence as a whole instant, and Feb 29 is the next leap year's, while an explicit past year and an impossible date are refused", async () => {
  await pinnedAt("2026-11-20T17:00:00Z");
  const cases: [string, number][] = [
    ["Nov 20 4PM UTC", Date.UTC(2027, 10, 20, 16)],
    ["Nov 20 UTC", Date.UTC(2027, 10, 20, 9)],
    ["Nov 20 6PM UTC", Date.UTC(2026, 10, 20, 18)],
    ["Nov 21 4PM UTC", Date.UTC(2026, 10, 21, 16)],
    ["Feb 28 4PM UTC", Date.UTC(2027, 1, 28, 16)],
    ["Feb 29 4PM UTC", Date.UTC(2028, 1, 29, 16)],
    ["Mar 8 2:30am America/New_York", Date.UTC(2027, 2, 8, 7, 30)],
    ["3/8 2:30am America/New_York", Date.UTC(2027, 2, 8, 7, 30)],
  ];
  for (const [said, expected] of cases) assert.equal(await yearless(said), expected, said);

  const card = await asked("Impossible dates");
  const before = await entries(card);
  const refused: [string, RegExp][] = [
    ["Nov 20 2025 4PM UTC", /in the past/],
    ["Feb 30 4PM UTC", /not a date that exists/],
    ["Apr 31 4PM UTC", /not a date that exists/],
    ["Feb 29 2027 4PM UTC", /not a date that exists/],
    [
      "Mar 8 2026 2:30am America/New_York",
      /02:30 does not exist in America\/New_York on 2026-03-08/,
    ],
    ["Mar 14 2:30am America/New_York", /02:30 does not exist in America\/New_York on 2027-03-14/],
  ];
  for (const [text, message] of refused) {
    const outcome = await fromBoard(card, text, "UTC");
    assert.equal(outcome.status, 400, text);
    assert.match(outcome.error ?? "", message, text);
  }
  assert.deepEqual(await entries(card), before);
});

test("Feb 29 is found up to eight years ahead", async () => {
  await pinnedAt("2096-03-01T00:00:00Z");
  assert.equal(await yearless("Feb 29 4PM UTC"), Date.UTC(2104, 1, 29, 16));
});

test("a wall time already passed today, this year, or this week is never converted, so a daylight-saving gap that has gone by never refuses the next occurrence", async () => {
  await pinnedAt("2027-03-14T16:00:00Z");
  const cases: [string, number][] = [
    ["2:30am America/New_York", Date.UTC(2027, 2, 15, 6, 30)],
    ["Mar 14 2:30am America/New_York", Date.UTC(2028, 2, 14, 6, 30)],
    ["Sunday 2:30am America/New_York", Date.UTC(2027, 2, 21, 6, 30)],
  ];
  for (const [said, expected] of cases) assert.equal(await yearless(said), expected, said);

  await pinnedAt("2027-03-13T12:00:00Z");
  const card = await asked("A time that does not exist");
  const before = await entries(card);
  const refused = [
    "Mar 14 2027 2:30am America/New_York",
    "Mar 14 2:30am America/New_York",
    "Sunday 2:30am America/New_York",
  ];
  for (const text of refused) {
    const message = /02:30 does not exist in America\/New_York on 2027-03-14/;
    const outcome = await fromBoard(card, text, "UTC");
    assert.equal(outcome.status, 400, text);
    assert.match(outcome.error ?? "", message, text);
  }
  assert.deepEqual(await entries(card), before);
});

test("connecting words in capitals are not zones: AT, ON, and the like hold the time he typed from the board", async () => {
  const day = 24 * 60 * MINUTE;
  const startOfToday = Math.floor(Date.now() / day) * day;
  const phrases: [string, (until: number) => boolean][] = [
    ["Dec 31 2099 4PM ON", (until) => until === Date.UTC(2099, 11, 31, 16)],
    ["4PM ON Dec 31 2099", (until) => until === Date.UTC(2099, 11, 31, 16)],
    ["Dec 31 2099 AT 4PM", (until) => until === Date.UTC(2099, 11, 31, 16)],
    ["TOMORROW 9AM", (until) => until === startOfToday + day + 9 * 60 * MINUTE],
    ["tomorrow AT 4PM", (until) => until === startOfToday + day + 16 * 60 * MINUTE],
    [
      "Friday AT 4PM",
      (until) => {
        const at = new Date(until);
        return at.getUTCDay() === 5 && at.getUTCHours() === 16 && until < startOfToday + 9 * day;
      },
    ],
  ];
  for (const [said, right] of phrases) {
    const read = await readDate(said, "UTC");
    assert.ok(right(read.until), `${said} from the board`);
    assert.equal(read.zone, "UTC");
  }
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

  const refused: [string, RegExp][] = [
    ["Jan 1 2020", /in the past/],
    ["Feb 30 2099", /not a date that exists/],
    ["tomorrow or Friday", /names two days/],
    ["2pm or 3pm", /names two times/],
    ["in 2 hours at 4pm", /both a time ahead and a time of day/],
    ["in 0 hours", /no time ahead/],
    ["25:00", /not a time of day/],
    ["4pm America/Nowhere", unknownZone("America/Nowhere")],
    ["Dec 31 2099 4PM CHT", unknownZone("CHT")],
    ["Dec 31 2099 4PM GMT+abc", unknownZone("GMT+abc")],
    ["Dec 31 2099 4PM +05:3", unknownZone("+05:3")],
    ["Dec 31 2099 4PM UTC+2:75", unknownZone("UTC+2:75")],
    ["Dec 31 2099 4PM +2000", unknownZone("+2000")],
    ["Dec 31 2099 4PM Canadaa/Eastern", unknownZone("Canadaa/Eastern")],
    ["Dec 31 2099 4PM CET+2", unknownZone("CET+2")],
    ["Dec 31 2099 4PM cet+abc", unknownZone("cet+abc")],
    ["Dec 31 2099 4PM CET+", unknownZone("CET+")],
    ["Dec 31 2099 4PM UTC+2:abc", unknownZone("UTC+2:abc")],
    ["Dec 31 2099 4PM UTC+2.foo", unknownZone("UTC+2.foo")],
    ["Dec 31 2099 4:PM UTC", /4:PM is not a time, a date, or a time zone/],
    ["Dec 31 2099 4.PM UTC", /4\.PM is not a time, a date, or a time zone/],
    ["Dec 31 2099 4PM +abc", unknownZone("+abc")],
    ["Dec 31 2099 4PM IN IST", unknownZone("IST")],
    ["Dec 31 2099 4PM AT IST", unknownZone("IST")],
    ["Dec 31 2099 4:5PM UTC", /4:5PM is not a time, a date, or a time zone the reader knows/],
    ["Dec 31 2099 4:05:07PM UTC", /4:05:07PM is not a time, a date, or a time zone/],
    ["Dec 31 2099 4PM c-12", /c-12 is not a time, a date, or a time zone/],
    ["Dec 31 2099 25:61 UTC", /25:61 is not a time of day/],
    ["in 2 hours IST", unknownZone("IST")],
    ["in 2 hours CHT", unknownZone("CHT")],
    ["Nov 20 2099 CHT", unknownZone("CHT")],
    ["4PM IST", unknownZone("IST")],
    ["4PM UTC+25", unknownZone("UTC+25")],
    ["4PM GMT+2:75", unknownZone("GMT+2:75")],
    ["4PM UTC-12:30", unknownZone("UTC-12:30")],
    ["4PM UTC+14:15", unknownZone("UTC+14:15")],
    ["4PM +05:75", unknownZone("+05:75")],
    [
      "Mar 8 2099 2:30am America/New_York",
      /02:30 does not exist in America\/New_York on 2099-03-08/,
    ],
    ["in 2 hours and 30 minutes", /more than one amount of time.*in 150 minutes/],
    ["in 1 day 3 hours", /more than one amount of time.*in 150 minutes/],
    ["in an hour and a half", /more than one amount of time.*in 150 minutes/],
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

test("only the captain's board can put his decision off: agents cannot invent his words", async () => {
  const card = await asked("Not for agents");
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
  assert.equal((await fromBoard(mates, "tomorrow", "UTC")).status, 400);

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
  const args = { hold: seen, said: "tomorrow", zone: "UTC" };
  assert.equal((await fleet.cardd.refusal(card.id, { kind: "hold", ...args })).status, 409);
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
    [`Merge ${PR}?`, true, ["Approve & merge"]],
  );
});
