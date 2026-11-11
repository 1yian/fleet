import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  CardViewSchema,
  check,
  idlePark,
  OPS,
  waitLine,
  type BoardCard,
  type Card,
  type DatedWait,
  type Entry,
} from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, oldDatedHold, startFleet, status, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.01" });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await Promise.allSettled([cleo.close()]);
  await fleet.cardd.stop();
});

const HOUR = 3_600_000;

async function onBoard(card: Card): Promise<BoardCard> {
  const cards = check(OPS.board.result, await cleo.call("board", {}));
  const found = cards.find((each) => each.id === card.id);
  if (found === undefined) throw new Error(`c-${String(card.id)} is not on the board`);
  return found;
}

const waitOf = async (card: Card): Promise<DatedWait | null> => (await onBoard(card)).datedWait;

async function waitReads(card: Card, watch: DatedWait["watch"]): Promise<DatedWait> {
  return until(
    async () => {
      const wait = await waitOf(card);
      return wait?.watch === watch ? wait : undefined;
    },
    `c-${String(card.id)} to read ${watch}`,
  );
}

const date = (card: Card, extra: Record<string, unknown>) => ({
  card: card.id,
  question: "Wait for it?",
  until: Date.now() + HOUR,
  ...extra,
});

async function holdEntries(card: Card): Promise<Entry[]> {
  return (await fleet.cardd.thread(card.id)).entries.filter((entry) => entry.kind === "hold");
}

async function closed(mate: Session, title: string): Promise<Card> {
  const card = await newCard(mate, title, "scout");
  await mate.call("close.finish", {
    card: card.id,
    mode: "done",
    text: title,
    archives: [],
    left: [],
  });
  return card;
}

test("a date on a hold is refused until it says what waits on the event and what work remains", async () => {
  const card = await newCard(cleo, "Quota card");
  const outside = { outside: "the weekly quota resets" };

  await assert.rejects(cleo.call("hold", date(card, {})), {
    message:
      /must say what it waits on, with exactly one of: job=.*schedule=.*worker=.*watcher=.*outside=.*said=.*idle park/,
  });
  await assert.rejects(cleo.call("hold", date(card, { ...outside, job: 1 })), {
    message: /exactly one of: job=/,
  });
  await assert.rejects(cleo.call("hold", date(card, outside)), {
    message: /must state the work that remains.*remaining=\[\].*remaining=\[<card numbers>\]/,
  });
  await assert.rejects(cleo.call("hold", { card: card.id, question: "Wait?", ...outside }), {
    message: /outside only go with until/,
  });
  await assert.rejects(cleo.call("hold", { card: card.id, question: "Wait?", remaining: [] }), {
    message: /remaining only go with until/,
  });
  assert.deepEqual(await holdEntries(card), []);
  assert.equal(await status(cleo, card), "queued");

  await cleo.call("hold", date(card, { ...outside, remaining: [] }));
  assert.equal(await status(cleo, card), "waiting");
});

test("remaining work must be open cards of the mate's own, each shown with its status", async () => {
  const card = await newCard(cleo, "Quota card");
  const other = await newCard(cleo, "Port the rest");
  const done = await closed(cleo, "Already finished");
  const mains = await newCard(fleet.main, "Main's own card");
  const outside = { outside: "the weekly quota resets" };
  const refusals: [number, RegExp][] = [
    [card.id, /needs a card of its own/],
    [done.id, /is done: a remaining step needs an open card/],
    [9999, /no card c-9999/],
    [mains.id, /belongs to lane main/],
  ];
  for (const [step, message] of refusals)
    await assert.rejects(cleo.call("hold", date(card, { ...outside, remaining: [step] })), {
      message,
    });
  assert.deepEqual(await holdEntries(card), []);

  await cleo.call("hold", date(card, { ...outside, remaining: [other.id] }));
  const view = check(CardViewSchema, await cleo.call("card", { card: card.id }));
  assert.deepEqual(view.hold?.remaining, [
    { card: other.id, title: "Port the rest", status: "queued" },
  ]);
  await cleo.call("hold", date(card, { ...outside, remaining: [] }));
  const none = check(CardViewSchema, await cleo.call("card", { card: card.id }));
  assert.deepEqual(none.hold?.remaining, []);
});

const readOf = async (card: Card): Promise<(string | undefined)[]> => {
  const wait = await waitOf(card);
  return [wait?.watch, wait?.what];
};

test("an outside date, a watcher fleet cannot check, and a worker are each shown for what they are", async () => {
  const quota = await newCard(cleo, "Quota card");
  await cleo.call("hold", date(quota, { outside: "the weekly quota resets", remaining: [] }));
  assert.deepEqual(await readOf(quota), ["outside", "the weekly quota resets"]);
  const until = (await waitOf(quota))?.until ?? 0;
  assert.equal(until > Date.now(), true);

  const named = await newCard(cleo, "Script card");
  const wake = "the 05:00 wake checks the nightly import";
  await cleo.call("hold", date(named, { watcher: wake, remaining: [] }));
  assert.deepEqual(await readOf(named), ["unchecked", wake]);

  const watched = await newCard(cleo, "Watched card");
  const worker = await fleet.cardd.connect(await begin(cleo, watched));
  await worker.call("report", { status: "working", text: "watching the CI run" });
  const waiter = await newCard(cleo, "Waiter card");
  await cleo.call("hold", date(waiter, { worker: watched.id, remaining: [] }));
  assert.deepEqual(await readOf(waiter), ["running", `the worker of c-${String(watched.id)}`]);
});

test("the captain's later is checked against what he wrote, the way a merge approval is", async () => {
  const later = await newCard(cleo, "Later card");
  const words = "Ask me again next week.";
  const said = date(later, { said: words, source: "record", remaining: [] });
  await assert.rejects(cleo.call("hold", said), {
    message: /not in the captain's messages or board entries/,
  });
  assert.equal(await fleet.cardd.act(later.id, { kind: "comment", text: words }), 200);
  await cleo.call("hold", said);
  assert.deepEqual(await readOf(later), ["later", words]);
});

test("a job that watches the event is shown running, and shown gone when it finishes or is lost", async () => {
  const card = await newCard(cleo, "Build card");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  const job = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "release build", command: "make release" }),
  ).job;
  const beat = setInterval(() => {
    worker.call("job.alive", { job }).catch(() => undefined);
  }, 20);
  const waiter = await newCard(cleo, "Waiter card");
  try {
    await cleo.call("hold", date(waiter, { job, remaining: [] }));
    const running = await waitOf(waiter);
    assert.deepEqual(
      [running?.watch, running?.what],
      ["running", `job ${String(job)} (release build)`],
    );
    await worker.call("job.finish", { job, exitCode: 0, outputTail: "done" });
  } finally {
    clearInterval(beat);
  }
  const gone = await waitReads(waiter, "gone");
  assert.equal(gone.what, `job ${String(job)} (release build) is finished`);
  assert.match(
    waitLine(gone, Date.now()),
    /^idle park, nothing running: job \d+ \(release build\) is finished, until /,
  );

  await assert.rejects(
    cleo.call("hold", date(await newCard(cleo, "Later"), { job, remaining: [] })),
    {
      message: /needs a watcher that runs now, and job \d+ \(release build\) is finished/,
    },
  );
  await assert.rejects(
    cleo.call("hold", date(await newCard(cleo, "Typo"), { job: 99_999, remaining: [] })),
    { message: /job 99999 is not in your lane, or does not exist/ },
  );

  const silent = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "silent", command: "sleep 99" }),
  ).job;
  const second = await newCard(cleo, "Second waiter");
  await cleo.call("hold", date(second, { job: silent, remaining: [] }));
  const lost = await waitReads(second, "gone");
  assert.equal(lost.what, `job ${String(silent)} (silent) is lost`);
});

test("a schedule that wakes the mate is shown running, and shown gone when it is removed", async () => {
  const schedule = check(
    OPS["schedule.set"].result,
    await cleo.call("schedule.set", {
      to: "cleo",
      at: "05:00",
      timezone: "UTC",
      text: "Check the quota.",
    }),
  ).id;
  const card = await newCard(cleo, "Quota card");
  await cleo.call("hold", date(card, { schedule, remaining: [] }));
  const running = await waitOf(card);
  assert.deepEqual(
    [running?.watch, running?.what],
    ["running", `schedule ${String(schedule)} (05:00 UTC)`],
  );

  await cleo.call("schedule.remove", { id: schedule });
  const gone = await waitReads(card, "gone");
  assert.match(gone.what, new RegExp(`schedule ${String(schedule)} is gone`));
  await assert.rejects(
    cleo.call("hold", date(await newCard(cleo, "Again"), { schedule, remaining: [] })),
    {
      message: /schedule \d+ is not in your lane, or does not exist/,
    },
  );
});

test("a worker named as the watcher is shown gone once its card closes", async () => {
  const watched = await newCard(cleo, "Watched card");
  await fleet.cardd.connect(await begin(cleo, watched));
  const waiter = await newCard(cleo, "Waiter card");
  await cleo.call("hold", date(waiter, { worker: watched.id, remaining: [] }));
  assert.equal((await waitOf(waiter))?.watch, "running");

  await cleo.call("close.finish", {
    card: watched.id,
    mode: "dropped",
    text: "dropped",
    archives: [],
    left: [],
  });
  const gone = await waitReads(waiter, "gone");
  assert.equal(gone.what, `the worker of c-${String(watched.id)} is not running`);
  await assert.rejects(
    cleo.call("hold", date(await newCard(cleo, "Again"), { worker: watched.id, remaining: [] })),
    { message: /the worker of c-\d+ is not running/ },
  );
});

test("a worker whose Pi has exited is not a watcher: its hold reads gone, and a new hold on it is refused", async () => {
  const watched = await newCard(cleo, "Watched card");
  const worker = await fleet.cardd.connect(await begin(cleo, watched));
  const waiter = await newCard(cleo, "Waiter card");
  await cleo.call("hold", date(waiter, { worker: watched.id, remaining: [] }));
  assert.equal((await waitOf(waiter))?.watch, "running");

  await worker.close();
  const gone = await waitReads(waiter, "gone");
  assert.equal(gone.what, `the worker of c-${String(watched.id)} is not running`);
  assert.equal(idlePark(gone), true);
  await assert.rejects(
    cleo.call("hold", date(await newCard(cleo, "Again"), { worker: watched.id, remaining: [] })),
    { message: /needs a watcher that runs now, and the worker of c-\d+ is not running/ },
  );
});

test("a worker that was dispatched but never connected is not a watcher, and one that connects becomes one", async () => {
  const watched = await newCard(cleo, "Watched card");
  const token = await begin(cleo, watched);
  await assert.rejects(
    cleo.call("hold", date(await newCard(cleo, "Waiter"), { worker: watched.id, remaining: [] })),
    { message: /needs a watcher that runs now, and the worker of c-\d+ is not running/ },
  );

  await fleet.cardd.connect(token);
  const waiter = await newCard(cleo, "Second waiter");
  await cleo.call("hold", date(waiter, { worker: watched.id, remaining: [] }));
  assert.equal((await waitOf(waiter))?.watch, "running");
});

test("a mate can watch only its own lane's job, schedule, and worker, and a refusal tells nothing about them", async () => {
  const quinn = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));
  const build = await newCard(cleo, "Build card");
  const worker = await fleet.cardd.connect(await begin(cleo, build));
  const job = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "secret release build", command: "make release" }),
  ).job;
  const beat = setInterval(() => {
    worker.call("job.alive", { job }).catch(() => undefined);
  }, 20);
  const schedule = check(
    OPS["schedule.set"].result,
    await cleo.call("schedule.set", {
      to: "cleo",
      at: "05:17",
      timezone: "Pacific/Auckland",
      text: "Check the quota.",
    }),
  ).id;
  const mine = await newCard(quinn, "Quinn card");
  const foreign: [string, Record<string, number>][] = [
    ["job", { job }],
    ["schedule", { schedule }],
    ["worker", { worker: build.id }],
  ];
  const absent: Record<string, Record<string, number>> = {
    job: { job: 99_999 },
    schedule: { schedule: 99_999 },
    worker: { worker: 99_999 },
  };
  const refusal = (card: Card, args: Record<string, number>): Promise<string> =>
    quinn.call("hold", date(card, { ...args, remaining: [] })).then(
      () => "accepted",
      (rejected: unknown) => (rejected instanceof Error ? rejected.message : String(rejected)),
    );
  try {
    for (const [kind, args] of foreign) {
      const message = await refusal(mine, args);
      assert.match(message, /^\w+ \d+ is not in your lane, or does not exist/);
      assert.doesNotMatch(message, /secret|release|05:17|Auckland|running|finished/);
      const missing = await refusal(mine, absent[kind] ?? {});
      assert.equal(
        message.replace(/\d+/, "N"),
        missing.replace(/\d+/, "N"),
        `a ${kind} of another lane reads like one that does not exist`,
      );
    }
    await worker.call("job.finish", { job, exitCode: 0, outputTail: "done" });
    assert.match(await refusal(mine, { job }), /^job \d+ is not in your lane, or does not exist/);
    assert.deepEqual(await holdEntries(mine), []);
    assert.equal(await status(quinn, mine), "queued");

    const mains = await newCard(fleet.main, "Main's own card");
    await fleet.main.call("hold", date(mains, { schedule, remaining: [] }));
    const seen = check(OPS.board.result, await fleet.main.call("board", {})).find(
      (each) => each.id === mains.id,
    );
    assert.deepEqual(
      [seen?.datedWait?.watch, seen?.datedWait?.what],
      ["running", `schedule ${String(schedule)} (05:17 Pacific/Auckland)`],
    );
  } finally {
    clearInterval(beat);
  }
});

test("a hold on a schedule that was removed stays gone when another lane's schedule takes its id, and shows nothing of that schedule", async () => {
  const quinn = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));
  const mine = check(
    OPS["schedule.set"].result,
    await cleo.call("schedule.set", {
      to: "cleo",
      at: "05:00",
      timezone: "UTC",
      text: "Check the quota.",
    }),
  ).id;
  const card = await newCard(cleo, "Quota card");
  await cleo.call("hold", date(card, { schedule: mine, remaining: [] }));
  assert.equal((await waitOf(card))?.watch, "running");
  await cleo.call("schedule.remove", { id: mine });

  const theirs = check(
    OPS["schedule.set"].result,
    await quinn.call("schedule.set", {
      to: "quinn",
      at: "05:17",
      timezone: "Pacific/Auckland",
      text: "Quinn's private wake.",
    }),
  ).id;
  assert.equal(theirs, mine, "quinn's schedule took the id of the one that was removed");

  const read = await waitOf(card);
  assert.deepEqual(
    [read?.watch, read?.what],
    ["gone", `schedule ${String(mine)} is gone (removed, or it fired once)`],
  );
  assert.equal(idlePark(read ?? undefined), true);
});

async function shownTo(reader: Session, card: Card) {
  const cards = check(OPS.board.result, await reader.call("board", {}));
  const view = check(CardViewSchema, await reader.call("card", { card: card.id }));
  return {
    board: cards.find((each) => each.id === card.id)?.datedWait,
    card: view.card.datedWait,
    remaining: view.hold?.remaining,
  };
}

async function assertHidden(reader: Session, card: Card, what: string, step: Card): Promise<void> {
  const seen = await shownTo(reader, card);
  assert.deepEqual([seen.board?.watch, seen.board?.what], ["running", what]);
  assert.deepEqual([seen.card?.watch, seen.card?.what], ["running", what]);
  assert.deepEqual(seen.remaining, [{ card: step.id, elsewhere: true }]);
  assert.doesNotMatch(JSON.stringify(seen), /secret|release|07:45|Tokyo/);
}

test("a hold that main dates against another lane's job, schedule, and card shows its own mate only the kinds and states, while main and the web board see everything", async () => {
  const quinn = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));
  const build = await newCard(quinn, "Quinn secret build");
  const worker = await fleet.cardd.connect(await begin(quinn, build));
  const job = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "secret release build", command: "make release" }),
  ).job;
  const beat = setInterval(() => {
    worker.call("job.alive", { job }).catch(() => undefined);
  }, 20);
  const schedule = check(
    OPS["schedule.set"].result,
    await quinn.call("schedule.set", {
      to: "quinn",
      at: "07:45",
      timezone: "Asia/Tokyo",
      text: "Check the secret quota.",
    }),
  ).id;
  const step = await newCard(quinn, "Quinn secret follow-up");
  const byJob = await newCard(cleo, "Cleo waits on a job");
  const bySchedule = await newCard(cleo, "Cleo waits on a schedule");
  try {
    for (const [card, ref] of [
      [byJob, { job }],
      [bySchedule, { schedule }],
    ] as const) {
      await cleo.call("hold", { card: card.id, question: "Can main decide?" });
      await fleet.main.call("hold", {
        ...date(card, { ...ref, remaining: [step.id] }),
        question: "Can main decide?",
      });
    }

    for (const [card, what] of [
      [byJob, "a job in another lane (running)"],
      [bySchedule, "a schedule in another lane (running)"],
    ] as const)
      await assertHidden(cleo, card, what, step);

    const full = await shownTo(fleet.main, byJob);
    assert.equal(full.board?.what, `job ${String(job)} (secret release build)`);
    assert.deepEqual(full.remaining, [
      { card: step.id, title: "Quinn secret follow-up", status: "queued" },
    ]);
    const web = (await fleet.cardd.board()).cards.find((each) => each.id === bySchedule.id);
    assert.equal(web?.datedWait?.what, `schedule ${String(schedule)} (07:45 Asia/Tokyo)`);

    await worker.call("job.finish", { job, exitCode: 0, outputTail: "done" });
    const done = await shownTo(cleo, byJob);
    assert.deepEqual([done.card?.watch, done.card?.what], ["gone", "a job in another lane (gone)"]);
  } finally {
    clearInterval(beat);
  }
});

test("a dated hold from before this information was kept reads as an idle park, and re-dating it keeps its age", async () => {
  const card = await newCard(cleo, "Old park");
  const opened = Date.now() - 6 * 24 * HOUR;
  oldDatedHold(fleet.cardd, card, "owner", opened, Date.now() + HOUR);
  const park = await waitReads(card, "none");
  assert.equal(park.since, opened);
  assert.equal(waitLine(park, Date.now()).startsWith("idle park, nothing running, until "), true);
  assert.match(waitLine(park, Date.now()), /held 6d$/);

  await cleo.call("hold", date(card, { outside: "quota resets", remaining: [] }));
  const dated = await waitOf(card);
  assert.deepEqual([dated?.watch, dated?.since], ["outside", opened]);
});

test("a hold that is dated again with the same words writes nothing, and a new watcher rewrites the same hold", async () => {
  const card = await newCard(cleo, "Quota card");
  const args = date(card, { outside: "quota resets", remaining: [] });
  await cleo.call("hold", args);
  await cleo.call("hold", args);
  assert.equal((await holdEntries(card)).length, 1);
  await cleo.call("hold", { ...args, outside: "quota resets on the 5th" });
  assert.equal((await holdEntries(card)).length, 2);
  assert.equal((await waitOf(card))?.what, "quota resets on the 5th");

  await cleo.call("hold", { card: card.id, question: "Wait for it?" });
  assert.equal(await waitOf(card), null);
});
