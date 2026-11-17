import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, CardViewSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

const HOUR = 3_600_000;

let fleet: Fleet;
let yang: Session;
let beats: NodeJS.Timeout[] = [];
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  yang = await fleet.cardd.connect(fleet.cardd.addLane("yang", "main"));
});
afterEach(async () => {
  for (const beat of beats) clearInterval(beat);
  beats = [];
  await Promise.allSettled([yang.close()]);
  await fleet.cardd.stop();
});

type Kind = "worker" | "job" | "schedule";
const KINDS: readonly Kind[] = ["worker", "job", "schedule"];

interface Watch {
  readonly ref: Record<string, number>;
  readonly end: () => Promise<void>;
}

async function watching(kind: Kind): Promise<Watch> {
  if (kind === "schedule") {
    const { id } = check(
      OPS["schedule.set"].result,
      await yang.call("schedule.set", {
        to: "yang",
        at: "05:00",
        timezone: "UTC",
        text: "Check the dependency.",
      }),
    );
    return {
      ref: { schedule: id },
      end: async () => {
        await yang.call("schedule.remove", { id });
      },
    };
  }
  const dependency = await newCard(yang, `Dependency ${kind}`);
  const worker = await fleet.cardd.connect(await begin(yang, dependency));
  if (kind === "worker") return { ref: { worker: dependency.id }, end: () => worker.close() };
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "dependency check", command: "make check" }),
  );
  beats.push(
    setInterval(() => {
      worker.call("job.alive", { job }).catch(() => undefined);
    }, 20),
  );
  return {
    ref: { job },
    end: async () => {
      await worker.call("job.finish", { job, exitCode: 0, outputTail: "done" });
    },
  };
}

const QUESTION = "Holding until the dependency finishes";

async function park(card: Card, ref: Record<string, number>, until = Date.now() + HOUR) {
  return yang.call("hold", {
    card: card.id,
    question: `${QUESTION} (c-${String(card.id)})`,
    until,
    ...ref,
    remaining: [],
  });
}

const asks = (session: Session, card: Card): Entry[] =>
  session.entries
    .map(({ entry }) => entry)
    .filter((entry) => entry.card === card.id && entry.kind === "hold");

async function decision(card: Card, question = "Which way should this go?"): Promise<void> {
  await yang.call("hold", { card: card.id, question });
}

const heardHold = (session: Session, card: Card): Promise<Entry> =>
  session.waitForEntry(
    (entry) => entry.card === card.id && entry.kind === "hold",
    `the hold on c-${String(card.id)}`,
  );

const name = (card: Card): string => `c-${String(card.id)}`;

const lists = (session: Session, card: Card, wanted: string): Promise<Entry> =>
  session.waitForEntry(
    (entry) =>
      entry.author === "check" &&
      entry.fields["condition"] === "decisions" &&
      entry.body.includes(wanted) &&
      new RegExp(`${name(card)}\\b`).test(entry.body),
    `a list that names ${name(card)}`,
  );

const GROUPS = /\n(?=Dated waits)/;
const actingPart = (entry: Entry): string => entry.body.split(GROUPS)[0] ?? "";
const watchedPart = (entry: Entry): string => entry.body.split(GROUPS)[1] ?? "";

async function holdOf(session: Session, card: Card) {
  return check(CardViewSchema, await session.call("card", { card: card.id })).hold;
}

async function statusOf(session: Session, card: Card): Promise<Card["status"]> {
  const cards = check(OPS.board.result, await session.call("board", {}));
  const found = cards.find((each) => each.id === card.id);
  if (found === undefined) throw new Error(`${name(card)} is not on the board`);
  return found.status;
}

const readsAs = async (session: Session, card: Card, watch: string) =>
  until(
    async () => {
      const cards = check(OPS.board.result, await session.call("board", {}));
      const wait = cards.find((each) => each.id === card.id)?.datedWait;
      return wait?.watch === watch ? wait : undefined;
    },
    `${name(card)} to read ${watch}`,
  );

test("a second mate's dated hold on a watcher fleet checks stays a quiet wait for main: held, listed as information, never a decision", async () => {
  const quiet: Card[] = [];
  for (const kind of KINDS) {
    const { ref } = await watching(kind);
    const card = await newCard(yang, `Waits on a ${kind}`);
    const accepted = check(CardSchema, await park(card, ref));
    assert.equal(accepted.status, "waiting");
    assert.equal(
      accepted.lane,
      "yang",
      "the held card and its watcher are both in yang's own lane",
    );
    quiet.push(card);
    assert.equal(await statusOf(fleet.main, card), "waiting");
    const hold = await holdOf(fleet.main, card);
    assert.equal(hold?.holder, "main", "the hold keeps its holder for the later gate");
    assert.deepEqual(hold.remaining, []);
    assert.equal((await readsAs(fleet.main, card, "running")).until > Date.now(), true);
  }
  const marker = await newCard(yang, "An ordinary decision");
  await decision(marker);

  await heardHold(fleet.main, marker);
  for (const card of quiet)
    assert.deepEqual(
      asks(fleet.main, card),
      [],
      `main was told of ${name(card)} as if the hold waited on it`,
    );

  const list = await lists(fleet.main, marker, "reminder:");
  assert.match(list.body, /^reminder: 1 card needs a decision or action from you\./);
  assert.deepEqual(actingPart(list).match(/c-\d+/g), [name(marker)]);
  for (const card of quiet) assert.match(watchedPart(list), new RegExp(`- ${name(card)} `));
  assert.match(watchedPart(list), /^Dated waits .*Information only, no action now:/);
});

test("an ordinary undated decision from a second mate still notifies main and is listed for action", async () => {
  const card = await newCard(yang, "Budget question");
  await yang.call("hold", {
    card: card.id,
    question: "Raise the budget?",
    options: ["Yes", "No"],
  });

  const told = await heardHold(fleet.main, card);
  assert.equal(told.author, "mate:yang");
  assert.equal(told.fields["holder"], "main");
  assert.equal(told.fields["until"], null);
  const list = await lists(fleet.main, card, "reminder:");
  assert.match(actingPart(list), new RegExp(`- ${name(card)} Budget question `));
  assert.match(actingPart(list), /main hold/);
  assert.equal(await statusOf(fleet.main, card), "with-mate");
});

test("a watched hold that is dated again stays quiet and keeps its occurrence, and an undated rewrite tells main", async () => {
  const { ref } = await watching("worker");
  const card = await newCard(yang, "Waits on a worker");
  await park(card, ref);
  const first = await holdOf(fleet.main, card);
  await yang.call("hold", {
    card: card.id,
    question: "Still waiting, with a later date",
    until: Date.now() + 2 * HOUR,
    ...ref,
    remaining: [],
  });
  const dated = await holdOf(fleet.main, card);
  assert.equal(dated?.question, "Still waiting, with a later date");
  assert.equal(dated.holder, "main");
  assert.equal(first !== null && dated.entry > first.entry, true);
  assert.equal(await statusOf(fleet.main, card), "waiting");

  const marker = await newCard(yang, "Marker decision");
  await decision(marker);
  await heardHold(fleet.main, marker);
  assert.deepEqual(asks(fleet.main, card), [], "the date and its rewrite were not announced");

  await decision(card, "The dependency is not the blocker: which way?");
  const asked = await heardHold(fleet.main, card);
  assert.equal(asked.body, "The dependency is not the blocker: which way?");
  assert.equal(asked.fields["until"], null);
  assert.equal(await statusOf(fleet.main, card), "with-mate");
  const list = await lists(fleet.main, card, "reminder:");
  assert.match(actingPart(list), new RegExp(`- ${name(card)} Waits on a worker `));

  await park(card, ref);
  assert.equal(await statusOf(fleet.main, card), "waiting");
  assert.equal(
    asks(fleet.main, card).length,
    1,
    "dating it again did not announce it a second time",
  );
});

test("main's reconnect sends it the decisions it was told, and never a quiet wait it was not", async () => {
  const { ref } = await watching("job");
  const waiter = await newCard(yang, "Waits on a job");
  await park(waiter, ref);
  const open = await newCard(yang, "Open decision");
  await decision(open);
  const told = await heardHold(fleet.main, open);

  await fleet.main.close();
  const back = await fleet.cardd.connect(fleet.mainToken);
  const again = await heardHold(back, open);
  assert.equal(again.id, told.id);
  const marker = await newCard(yang, "Marker decision");
  await decision(marker);
  await heardHold(back, marker);
  assert.deepEqual(asks(back, waiter), []);
});

test("a watched hold wakes main when its date passes", async () => {
  const { ref } = await watching("worker");
  const card = await newCard(yang, "Waits on a worker");
  const ends = Date.now() + 2_000;
  await park(card, ref, ends);
  assert.equal(await statusOf(fleet.main, card), "waiting");

  const woken = await fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === `hold-ended:${String(ends)}`,
    "the hold ended finding",
  );
  assert.ok(woken.createdAt >= ends, "main heard only after the date");
  assert.match(woken.body, /^hold ended; it waits on main again/);
  assert.deepEqual(asks(fleet.main, card), []);
  assert.equal(await statusOf(fleet.main, card), "with-mate");
  const list = await lists(fleet.main, card, "reminder:");
  assert.match(actingPart(list), new RegExp(`- ${name(card)} Waits on a worker `));
});

for (const kind of KINDS)
  test(`a quiet wait on a ${kind} becomes an idle park that main is told to act on once the ${kind} is gone`, async () => {
    const { ref, end } = await watching(kind);
    const card = await newCard(yang, `Waits on a ${kind}`);
    await park(card, ref);
    assert.equal((await readsAs(fleet.main, card, "running")).watch, "running");

    await end();
    const gone = await readsAs(fleet.main, card, "gone");
    assert.match(gone.what, /not running|is finished|is gone/);
    const list = await lists(fleet.main, card, "reminder:");
    assert.match(actingPart(list), new RegExp(`- ${name(card)} .*idle park, nothing running`));
    assert.doesNotMatch(watchedPart(list), new RegExp(name(card)));
    assert.deepEqual(asks(fleet.main, card), []);
    assert.equal(await statusOf(fleet.main, card), "waiting");
  });
