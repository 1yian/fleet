import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { check, HttpOutcomeSchema, OPS, type Card } from "@fleet/protocol";
import { status, type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import { jobHelpers, makeJobProxy, until } from "../support/job-env.ts";
import type { Harness } from "../support/harness.ts";
import type { HerdrLab } from "../support/herdr.ts";
import { until as untilAsync } from "../support/live-fleet.ts";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let jobDir: string;
let card: Card;
let jl: JobLab;
const current = () => ({ fleet, h, lab, env, jobDir, card });
beforeEach(async () => {
  jl = await JobLab.start();
  ({ fleet, h, lab, env, jobDir, card } = jl);
});
afterEach(async (t) => {
  await jl.stop(t);
});
const {
  worker,
  said,
  settled,
  callCardd,
  cardView,
  jobResults,
  cardReports,
  commandAwaitingGo,
  wrapperOf,
} = jobHelpers(current);
const jobProxy = makeJobProxy(current);

for (const fault of ["failed", "hanging"] as const) {
  test(`a partial job list preserves the wait and a ${fault} read cannot block the result`, async (t) => {
    let mode: "observe" | "omit" | typeof fault = "observe";
    const lists: number[][] = [];
    const activities: string[] = [];
    const disconnect = await jobProxy(
      t,
      callCardd,
      false,
      (reply) => {
        assert.ok(reply.ok);
        lists.push(check(OPS.jobs.result, reply.value).map(({ id }) => id));
        if (mode === "omit") return { ...reply, value: [] };
        if (mode === "failed")
          return { t: "result", id: reply.id, ok: false, error: "jobs read unavailable" };
        if (mode === "hanging") return undefined;
        return reply;
      },
      undefined,
      undefined,
      undefined,
      (message) => {
        if (message.t === "activity") activities.push(message.state);
      },
    );
    const slow = commandAwaitingGo(81);
    h.onModel(() => ({ tool: "run_long", args: { label: "partial", command: slow.command } }));
    h.onModel(() => ({ text: "Waiting for the command" }));
    const pi = worker();
    await until(() => (existsSync(slow.ready) ? true : undefined), "the registered command to run");
    await settled(1);
    disconnect();
    await until(
      () => (lists.some((ids) => ids.includes(1)) ? true : undefined),
      "a full list to show the registered job",
    );
    h.onModel(() => ({ text: "Full snapshot acknowledged" }));
    const fullDelivered = h.events.filter((event) => event["type"] === "fleet_delivered").length;
    await fleet.main.call("comment", {
      card: card.id,
      text: "Acknowledge the full snapshot",
      later: false,
    });
    await h.waitForNth(
      (event) => event["type"] === "fleet_delivered",
      fullDelivered + 1,
      "a push that the worker can only receive after applying the full snapshot",
    );
    await settled(2);
    const beforePartial = lists.length;
    mode = "omit";
    disconnect();
    await until(
      () => (lists.length > beforePartial ? true : undefined),
      "the partial reconnect list",
    );
    assert.deepEqual(lists.at(-1), [1]);
    h.onModel(() => ({ text: "Snapshot acknowledged" }));
    h.onModel(() => ({ text: "Still waiting for the running job" }));
    const deliveredBefore = h.events.filter((event) => event["type"] === "fleet_delivered").length;
    await fleet.main.call("comment", {
      card: card.id,
      text: "Acknowledge the snapshot",
      later: false,
    });
    await h.waitForNth(
      (event) => event["type"] === "fleet_delivered",
      deliveredBefore + 1,
      "a push that the worker can only receive after applying the partial snapshot",
    );
    await settled(3);
    const sentBefore = activities.length;
    pi.prompt("Check whether the job is still being waited on");
    await settled(4);
    assert.equal(said("Your run is ending without a handoff"), false);
    const sent = await until(() => {
      const after = activities.slice(sentBefore);
      return after.includes("running") && after.at(-1) !== "running" ? after.at(-1) : undefined;
    }, "the worker to send its settled activity after the partial list");
    assert.equal(sent, "waiting");
    const beforeFault = lists.length;
    mode = fault;
    disconnect();
    await until(
      () => (lists.length > beforeFault ? true : undefined),
      "the unanswered or rejected job read",
    );
    writeFileSync(slow.go, "");
    await until(
      () => (said("job 1 (partial) exited 0: late") ? true : undefined),
      "the durable result despite the list failure",
    );
    assert.deepEqual(await jobResults(), [[1, 0, "late"]]);
  });
}

for (const fault of ["failed", "partial"] as const) {
  test(`an automatic stop after cold reload respects a running job despite a ${fault} initial list`, async (t) => {
    const faultSent = Promise.withResolvers<number[]>();
    let reportCalls = 0;
    let reloading = false;
    await jobProxy(
      t,
      callCardd,
      false,
      (reply) => {
        if (!reloading) return reply;
        assert.ok(reply.ok);
        faultSent.resolve(check(OPS.jobs.result, reply.value).map(({ id }) => id));
        return fault === "failed"
          ? { t: "result", id: reply.id, ok: false, error: "jobs read unavailable" }
          : { ...reply, value: [] };
      },
      (reply) => {
        reportCalls += 1;
        return reply;
      },
    );
    const slow = commandAwaitingGo(82);
    t.after(() => {
      if (existsSync(jobDir)) writeFileSync(slow.go, "");
    });
    h.onModel(() => ({ tool: "run_long", args: { label: "cold", command: slow.command } }));
    h.onModel(() => ({ text: "Waiting for the command" }));
    const first = worker();
    await until(() => (existsSync(slow.ready) ? true : undefined), "the registered command to run");
    await settled(1);
    await first.kill();

    reloading = true;
    const second = worker();
    await h.waitForNth(
      (e) => e["type"] === "fleet_connected",
      2,
      "the new worker process to connect",
    );
    assert.deepEqual(await faultSent.promise, [1]);
    h.onModel(() => ({ text: "The command still has work" }));
    second.prompt("Check on the command after reload");
    await settled(2);
    const published = await untilAsync(async () => {
      const state = (await cardView()).card.activity?.state;
      return state === "running" ? undefined : state;
    }, "the worker to publish its settled activity");
    assert.equal(published, "waiting");
    assert.equal(reportCalls, 0);
    assert.equal(said("Your run is ending without a handoff"), false);
    assert.deepEqual(await cardReports(), []);
    assert.equal(await status(fleet.main, card), "working");

    h.onModel(() => ({ text: "The command has finished" }));
    h.onModel(() => ({ text: "Nothing else to report" }));
    writeFileSync(slow.go, "");
    await fleet.main.waitForEntry(
      (entry) => entry.kind === "report" && entry.fields["status"] === "stopped",
      "the stopped handoff after the command exits",
    );
    assert.deepEqual(await jobResults(), [[1, 0, "late"]]);
    assert.ok(said("Your run is ending without a handoff"));
    assert.deepEqual(await cardReports(), [
      ["stopped", "ended the run without a handoff: Nothing else to report"],
    ]);
    assert.equal(await status(fleet.main, card), "with-mate");
  });
}

test("a delayed positive job list cannot restore a wait after confirmed loss", async (t) => {
  const activities: string[] = [];
  const snapshot = Promise.withResolvers<() => void>();
  let holdList = false;
  let confirmedLoss = false;
  const disconnect = await jobProxy(
    t,
    callCardd,
    false,
    (reply, send) => {
      if (!holdList || !reply.ok) return reply;
      assert.deepEqual(check(OPS.jobs.result, reply.value), [
        { id: 1, label: "delayed" },
        { id: 2, label: "other" },
      ]);
      holdList = false;
      snapshot.resolve(() => {
        send(reply);
      });
      return undefined;
    },
    undefined,
    undefined,
    undefined,
    (message) => {
      if (message.t === "activity") activities.push(message.state);
    },
    (reply) => {
      if (reply.ok) confirmedLoss = !check(OPS["job.running"].result, reply.value).running;
      return reply;
    },
  );
  const slow = commandAwaitingGo(88);
  t.after(() => {
    if (existsSync(h.dir)) writeFileSync(slow.go, "");
  });
  h.onModel(() => ({ tool: "run_long", args: { label: "delayed", command: slow.command } }));
  h.onModel(() => ({ text: "Waiting for the job" }));
  for (let i = 0; i < 12; i++) h.onModel(() => ({ text: "Noted" }));
  worker();
  const wrapper = await wrapperOf(1, slow.ready);
  await settled(1);
  await until(() => (activities.at(-1) === "waiting" ? true : undefined), "the initial wait");
  const token = env["FLEET_TOKEN"] ?? "";
  const started = await fleet.cardd.post(token, "job.start", {
    label: "other",
    command: "sleep 99",
  });
  const outcome = check(HttpOutcomeSchema, started.body);
  assert.ok(outcome.ok);
  const other = check(OPS["job.start"].result, outcome.value);
  assert.equal(other.job, 2);
  const beat = setInterval(() => {
    fleet.cardd.post(token, "job.alive", { job: 2 }).catch(() => undefined);
  }, 200);
  t.after(() => {
    clearInterval(beat);
  });
  holdList = true;
  disconnect();
  const releaseList = await snapshot.promise;
  jl.probe.silence(wrapper);
  try {
    const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
    try {
      db.prepare("UPDATE jobs SET updated_at = updated_at - 60000 WHERE id = 1").run();
    } finally {
      db.close();
    }
    await until(
      () => (confirmedLoss && activities.at(-1) === "idle" ? true : undefined),
      "the worker to publish idle after the exact loss read",
    );
    releaseList();
    await until(
      () => (activities.at(-1) === "waiting" ? true : undefined),
      "the worker to consume the held list and wait on its other job",
    );
    const finished = await fleet.cardd.post(token, "job.finish", {
      job: 2,
      exitCode: 0,
      outputTail: "other done",
    });
    assert.equal(finished.status, 200);
    await until(
      () => (activities.at(-1) === "idle" ? true : undefined),
      "the worker to publish idle once only the stale job could still hold the wait",
    );
  } finally {
    clearInterval(beat);
    jl.probe.resume(wrapper);
  }
});
