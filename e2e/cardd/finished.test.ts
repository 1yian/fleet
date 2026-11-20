import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CardSchema, CardViewSchema, check } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: Fleet | undefined;
afterEach(async () => fleet?.cardd.stop());

async function startClocked(): Promise<{
  fleet: Fleet;
  advance: (ms: number) => void;
  tick: () => Promise<void>;
}> {
  const dir = tempDir("finished-clock-");
  mkdirSync(dir, { recursive: true });
  const clock = join(dir, "clock");
  const advance = (ms: number): void => {
    writeFileSync(`${clock}.next`, new Date(ms).toISOString());
    renameSync(`${clock}.next`, clock);
  };
  advance(Date.now());
  const started = await startFleet({ CARDD_TIMING_SCALE: "0.001", CARDD_CLOCK_FILE: clock });
  fleet = started;
  const tick = async (): Promise<void> => {
    const witness = await newCard(started.main, "A poll witness");
    await begin(started.main, witness);
    await started.main.waitForEntry(
      (entry) =>
        entry.card === witness.id && entry.fields["condition"] === "worker-never-connected",
      "the poll after the clock advances",
    );
  };
  return { fleet: started, advance, tick };
}

test("finished reminders wait ten minutes, repeat every ten minutes, and never reach the parent", async () => {
  const { fleet: started, advance, tick } = await startClocked();
  const { main, cardd } = started;
  const mate = await cardd.connect(cardd.addLane("cleo", "main"));
  const card = await newCard(mate, "Read the report", "scout");
  const worker = await cardd.connect(await begin(mate, card));
  await worker.call("report", { status: "done", text: "report written" });
  const entries = async () =>
    check(CardViewSchema, await mate.call("card", { card: card.id })).entries;
  const report = (await entries()).find((entry) => entry.fields["status"] === "done");
  assert.ok(report !== undefined);
  const reminders = async () =>
    (await entries()).filter((entry) => entry.fields["condition"] === "finished");
  advance(report.createdAt + 599);
  await tick();
  assert.deepEqual(await reminders(), []);
  advance(report.createdAt + 600);
  await mate.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["condition"] === "finished" &&
      entry.fields["tier"] === 1,
    "first reminder",
  );
  advance(report.createdAt + 1_199);
  await tick();
  assert.equal((await reminders()).length, 1);
  advance(report.createdAt + 1_200);
  await mate.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["condition"] === "finished" &&
      entry.fields["tier"] === 2,
    "second reminder",
  );
  assert.equal((await reminders()).length, 2);
  assert.deepEqual(
    main.entries.filter(
      ({ entry }) => entry.card === card.id && entry.fields["condition"] === "finished",
    ),
    [],
  );
  await mate.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "read",
    next: { drop: "nothing to build" },
    archives: [],
    left: [],
  });
  advance(report.createdAt + 2_400);
  await tick();
  assert.equal((await reminders()).length, 2);
});

test("a finished ops card is reminded to close it, and its Done close ends the reminders", async () => {
  const { fleet: started, advance, tick } = await startClocked();
  const { main, cardd } = started;
  const card = await newCard(main, "Rotate the credential");
  assert.equal(cardd.admin("card", "delivery", String(card.id), "ops").status, 0);
  const worker = await cardd.connect(await begin(main, card));
  const evidence = `/home/worker/.fleet/scratch/c-${String(card.id)}/operation.md`;
  await worker.call("report", { status: "done", text: "operation complete", evidence });
  const entries = async () =>
    check(CardViewSchema, await main.call("card", { card: card.id })).entries;
  const report = (await entries()).find((entry) => entry.fields["status"] === "done");
  assert.ok(report !== undefined);
  const reminders = async () =>
    (await entries()).filter((entry) => entry.fields["condition"] === "finished");

  advance(report.createdAt + 600);
  const first = await main.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["condition"] === "finished" &&
      entry.fields["tier"] === 1,
    "first reminder",
  );
  assert.match(
    first.body,
    new RegExp(
      `^reminder: c-${String(card.id)} is finished and still open \\(with-mate, \\d+ min\\)\\. Its worker handed over the evidence report\\. Close it with close\\(card, summary\\)`,
    ),
  );
  assert.doesNotMatch(first.body, /not available yet|Do not call close/);

  const closed = check(
    CardSchema,
    await main.call("close.finish", {
      card: card.id,
      mode: "done",
      text: "operation done",
      archives: [],
      left: [],
    }),
  );
  assert.equal(closed.status, "done");
  advance(report.createdAt + 2_400);
  await tick();
  assert.equal((await reminders()).length, 1);
});
