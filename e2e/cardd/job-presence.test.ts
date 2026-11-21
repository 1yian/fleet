import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { begin, newCard } from "../support/fleet.ts";
import { spawnOwned } from "../support/marked.ts";
import { ProbeRoute } from "../support/probe-route.ts";
import { until } from "../support/live-fleet.ts";

let cardd: Cardd;
let main: Session;
let worker: Session;
let card: Card;
let probe: ProbeRoute;
const wrappers: number[] = [];

beforeEach(async () => {
  probe = new ProbeRoute();
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.001" }, ["--hosts", probe.hosts]);
  const mainToken = cardd.addLane("main");
  cardd.addProject("web", { maverick: "/clones/web", p620: "/clones/web" }, "acme/web");
  main = await cardd.connect(mainToken);
  card = await newCard(main, "a wrapper that falls silent");
  worker = await cardd.connect(await begin(main, card));
});

afterEach(async () => {
  for (const pid of wrappers.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      continue;
    }
  }
  await cardd.stop();
});

function liveProcess(name: string): number {
  const child = spawnOwned("sh", ["-c", "sleep 600; :", name], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("the stand-in wrapper did not start");
  wrappers.push(child.pid);
  return child.pid;
}

async function registered(label: string, named = true): Promise<{ job: number; pid: number }> {
  const launch = randomUUID();
  const { job } = check(
    OPS["job.prepare"].result,
    await worker.call("job.prepare", { label, command: `run ${label}`, launch }),
  );
  const pid = liveProcess(named ? `fleet-job-${String(job)}-${launch}.json` : "unrelated");
  assert.deepEqual(await worker.call("job.register", { job, launch, pid }), { registered: true });
  return { job, pid };
}

const running = async (job: number): Promise<boolean> =>
  check(OPS["job.running"].result, await worker.call("job.running", { job })).running;

const lostFinding = (job: number): Promise<unknown> =>
  main.waitForEntry(
    (entry) => entry.fields["condition"] === "job-lost" && entry.fields["job"] === job,
    `the loss of job ${String(job)}`,
  );

const lostFindings = (): number =>
  main.entries.filter(({ entry }) => entry.fields["condition"] === "job-lost").length;

test("a registered job that goes silent while its wrapper lives is not lost, and one whose wrapper is gone is", async () => {
  const alive = await registered("alive");
  const doomed = await registered("gone");
  process.kill(-doomed.pid, "SIGKILL");

  await lostFinding(doomed.job);
  assert.equal(await running(doomed.job), false);
  assert.equal(await running(alive.job), true);
  assert.equal(lostFindings(), 1);
  const told = await worker.waitForEntry(
    (entry) => entry.fields["job"] === doomed.job && entry.fields["lost"] === true,
    "the worker's loss notice",
  );
  assert.match(told.body, /its wrapper process is gone/);
  assert.equal(
    worker.entries.some(({ entry }) => entry.fields["job"] === alive.job && entry.fields["lost"]),
    false,
  );
});

test("a wrapper pid that now belongs to an unrelated process does not keep a job running", async () => {
  const reused = await registered("reused", false);
  const alive = await registered("alive");

  await lostFinding(reused.job);
  assert.equal(await running(reused.job), false);
  assert.equal(await running(alive.job), true);
  assert.equal(lostFindings(), 1);
});

test("an unreadable or partial probe keeps a job waiting, and the loss lands once the wrapper is confirmed gone", async () => {
  probe.say("offline");
  const doomed = await registered("unknown");
  process.kill(-doomed.pid, "SIGKILL");

  for (const kind of ["offline", "partial", "missing"] as const) {
    probe.say(kind);
    const seen = probe.count(kind);
    await until(() => (probe.count(kind) >= seen + 3 ? true : undefined), `three ${kind} probes`);
    assert.equal(await running(doomed.job), true, `a ${kind} read lost the job`);
    assert.equal(lostFindings(), 0);
  }

  probe.say("live");
  await lostFinding(doomed.job);
  assert.equal(await running(doomed.job), false);
});
