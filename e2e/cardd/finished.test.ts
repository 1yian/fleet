import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CardViewSchema, check } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: Fleet | undefined;
afterEach(async () => fleet?.cardd.stop());

test("finished reminders wait two hours, repeat every two hours, and never reach the parent", async () => {
  const dir = tempDir("finished-clock-");
  mkdirSync(dir, { recursive: true });
  const clock = join(dir, "clock");
  const advance = (ms: number): void => {
    writeFileSync(`${clock}.next`, new Date(ms).toISOString());
    renameSync(`${clock}.next`, clock);
  };
  advance(Date.now());
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001", CARDD_CLOCK_FILE: clock });
  const { main, cardd } = fleet;
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
  const tick = async (): Promise<void> => {
    const witness = await newCard(main, "A poll witness");
    await begin(main, witness);
    await main.waitForEntry(
      (entry) =>
        entry.card === witness.id && entry.fields["condition"] === "worker-never-connected",
      "the poll after the clock advances",
    );
  };
  advance(report.createdAt + 7_199);
  await tick();
  assert.deepEqual(await reminders(), []);
  advance(report.createdAt + 7_200);
  await mate.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["tier"] === 1,
    "first reminder",
  );
  advance(report.createdAt + 14_399);
  await tick();
  assert.equal((await reminders()).length, 1);
  advance(report.createdAt + 14_400);
  await mate.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["tier"] === 2,
    "second reminder",
  );
  assert.equal((await reminders()).length, 2);
  assert.deepEqual(
    main.entries.filter(({ entry }) => entry.card === card.id && entry.author === "check"),
    [],
  );
  await mate.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "read",
    archives: [],
    left: [],
  });
  advance(report.createdAt + 28_800);
  await tick();
  assert.equal((await reminders()).length, 2);
});
