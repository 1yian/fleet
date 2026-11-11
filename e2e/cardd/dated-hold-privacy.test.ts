import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
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

const date = (card: Card, extra: Record<string, unknown>) => ({
  card: card.id,
  question: "Wait for it?",
  until: Date.now() + HOUR,
  ...extra,
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

test("a list to main that names another lane's finished job stays out of the held card's history for its own mate, and main still reads it", async () => {
  const quinn = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));
  const build = await newCard(quinn, "Quinn build");
  const worker = await fleet.cardd.connect(await begin(quinn, build));
  const job = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "secret release build", command: "make release" }),
  ).job;
  const held = await newCard(cleo, "Cleo waits on a job");
  await cleo.call("hold", { card: held.id, question: "Can main decide?" });
  await fleet.main.call("hold", {
    ...date(held, { job, remaining: [] }),
    question: "Can main decide?",
  });
  await worker.call("job.finish", { job, exitCode: 0, outputTail: "done" });

  const list = await until(
    () =>
      fleet.main.entries
        .map(({ entry }) => entry)
        .find(
          (entry) =>
            entry.fields["condition"] === "decisions" &&
            entry.body.includes("secret release build"),
        ),
    "main's list that names the finished job",
  );
  assert.equal(list.card, held.id);

  const own = check(CardViewSchema, await cleo.call("card", { card: held.id }));
  assert.deepEqual(
    own.entries.filter((entry) => entry.fields["condition"] === "decisions"),
    [],
  );
  assert.doesNotMatch(JSON.stringify(own), /secret|release/);
  const seen = check(CardViewSchema, await fleet.main.call("card", { card: held.id }));
  assert.equal(
    seen.entries.some((entry) => entry.id === list.id),
    true,
  );
});
