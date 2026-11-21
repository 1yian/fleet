import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import {
  begin,
  newCard,
  pastClock,
  registeredAt,
  startFleet,
  type Fleet,
} from "../support/fleet.ts";
import { ProbeRoute } from "../support/probe-route.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" }, ["--hosts", new ProbeRoute().hosts]);
  viewer = fleet.main;
});
afterEach(async () => {
  await fleet.cardd.stop();
});

let viewer: Session;

async function exitedPid(): Promise<number> {
  const child = spawn("true", { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("the stand-in wrapper did not start");
  return child.pid;
}

const findings = async (card: Card): Promise<Entry[]> =>
  check(CardViewSchema, await viewer.call("card", { card: card.id })).entries.filter(
    (entry) => entry.kind === "finding" && entry.author === "check",
  );

test("a lost job dropped by its worker or its mate stops its reminders for good, and an undropped one keeps them", async () => {
  const card = await newCard(fleet.main, "dropped jobs");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const start = async (label: string): Promise<number> =>
    check(OPS["job.start"].result, await worker.call("job.start", { label, command: "sleep 9" }))
      .job;
  const byWorker = await start("server-a");
  const byMate = await start("server-b");
  const kept = await start("server-c");
  const reminders = async (job: number): Promise<Entry[]> =>
    (await findings(card)).filter(
      (entry) =>
        entry.fields["condition"] === "job-lost-open" &&
        entry.body.includes(`job ${String(job)} (`),
    );
  const reminded = (session: Session, job: number, tier: number): Promise<Entry> =>
    session.waitForEntry(
      (entry) =>
        entry.card === card.id &&
        entry.fields["condition"] === "job-lost-open" &&
        entry.body.includes(`job ${String(job)} (`) &&
        Number(entry.fields["tier"]) >= tier,
      `job ${String(job)} reminder tier ${String(tier)}`,
    );
  for (const job of [byWorker, byMate, kept]) await reminded(fleet.main, job, 2);
  assert.match((await reminders(kept))[0]?.body ?? "", /drop it with drop_job/);

  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  await assert.rejects(cleo.call("job.drop", { job: kept }), /not one of yours/);
  await assert.rejects(worker.call("job.drop", { job: 9999 }), /not one of yours/);
  const other = await newCard(fleet.main, "someone else's card");
  const stranger = await fleet.cardd.connect(await begin(fleet.main, other));
  await assert.rejects(stranger.call("job.drop", { job: kept }), /not one of yours/);

  const dropWorker = { job: byWorker };
  const first = check(OPS["job.drop"].result, await worker.call("job.drop", dropWorker));
  const again = check(OPS["job.drop"].result, await worker.call("job.drop", dropWorker));
  assert.deepEqual(first, { label: "server-a", state: "lost", dropped: true });
  assert.deepEqual(again, first);
  const mate = check(OPS["job.drop"].result, await fleet.main.call("job.drop", { job: byMate }));
  assert.deepEqual(mate, { label: "server-b", state: "lost", dropped: true });

  const droppedCounts = async (): Promise<number[]> => [
    (await reminders(byWorker)).length,
    (await reminders(byMate)).length,
  ];
  const stopped = await droppedCounts();
  const control = (await reminders(kept)).length;
  await reminded(fleet.main, kept, control + 2);
  assert.deepEqual(await droppedCounts(), stopped);

  await fleet.cardd.restart();
  const back = await fleet.cardd.connect(fleet.mainToken);
  viewer = back;
  const afterRestart = (await reminders(kept)).length;
  await reminded(back, kept, afterRestart + 2);
  assert.deepEqual(await droppedCounts(), stopped);
  assert.ok((await findings(card)).some((entry) => entry.fields["condition"] === "job-lost"));
  assert.deepEqual(
    check(OPS["job.drop"].result, await back.call("job.drop", { job: byMate })),
    mate,
  );
});

test("a lost job is superseded by the same-label job that registered later, whatever order they were reserved in", async () => {
  const card = await newCard(fleet.main, "overlapping launches");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const reserve = async (label: string) => {
    const launch = randomUUID();
    const { job } = check(
      OPS["job.prepare"].result,
      await worker.call("job.prepare", { label, command: `run ${label}`, launch }),
    );
    return { job, launch };
  };
  const reservedFirst = await reserve("server");
  const reservedSecond = await reserve("server");
  assert.ok(reservedSecond.job > reservedFirst.job);
  const register = (run: { job: number; launch: string }, pid: number) =>
    worker.call("job.register", { job: run.job, launch: run.launch, pid });
  assert.deepEqual(await register(reservedSecond, await exitedPid()), { registered: true });
  const secondRegistered = registeredAt(fleet.cardd, reservedSecond.job);
  pastClock(secondRegistered);
  assert.deepEqual(await register(reservedFirst, await exitedPid()), { registered: true });
  assert.ok(registeredAt(fleet.cardd, reservedFirst.job) > secondRegistered);

  const reminders = async (job: number): Promise<Entry[]> =>
    (await findings(card)).filter(
      (entry) =>
        entry.fields["condition"] === "job-lost-open" &&
        entry.body.includes(`job ${String(job)} (`),
    );
  await fleet.main.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["condition"] === "job-lost-open" &&
      entry.body.includes(`job ${String(reservedFirst.job)} (`) &&
      Number(entry.fields["tier"]) >= 2,
    "the later-registered job's reminders, which nothing supersedes",
  );
  assert.deepEqual(await reminders(reservedSecond.job), []);
});
