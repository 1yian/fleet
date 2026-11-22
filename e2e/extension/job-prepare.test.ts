import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { check, HttpOutcomeSchema, OPS, type Card } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import { jobHelpers, lastUser, makeJobProxy } from "../support/job-env.ts";
import type { Harness } from "../support/harness.ts";
import type { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

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
const { worker, said, callCardd, workspace, tabsInWorkspace, jobResults, waitTabGone } =
  jobHelpers(current);
const jobProxy = makeJobProxy(current);

test("a failed pipeline wakes the worker with failure, and the wait is not a stall", async () => {
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "tests", command: "(echo one; echo two; exit 3) | tail -n 2" },
  }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "two tests fail" } }));
  worker();
  await fleet.main.waitForEntries(1);

  assert.equal(
    lastUser(await h.waitForCall(2)),
    "[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 3: one\ntwo",
  );
  assert.ok(said("job 1 (tests) in tab job-1-tests"));
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [["failed", "two tests fail"]],
  );
  const labels = async (): Promise<unknown[]> =>
    records(
      (await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]))["tabs"],
    ).map((tab) => tab["label"]);
  const deadline = Date.now() + 10_000;
  while ((await labels()).includes("job-1-tests") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await labels(), ["1"]);
});

test("run_long recovers a committed reservation after torn prepare replies and runs once", async (t) => {
  const receipts: number[] = [];
  await jobProxy(t, async (op, args) => {
    const result = await callCardd(op, args);
    const outcome = check(HttpOutcomeSchema, result.body);
    if (op === "job.prepare" && outcome.ok) {
      receipts.push(check(OPS["job.prepare"].result, outcome.value).job);
      if (receipts.length === 1) return { ...result, body: '{"ok":true,"value":' };
      if (receipts.length === 2)
        return { ...result, body: { ok: true, value: { job: receipts[1] } } };
    }
    return result;
  });

  const marker = join(jobDir, "executions");
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "recover", command: `echo executed >> ${quote(marker)}; echo recovered` },
  }));
  h.onModel(() => ({ text: "waiting for the command" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "result received" } }));
  worker();
  await h.waitForCall(2);
  assert.ok(said("job 1 (recover) in tab job-1-recover"));
  await fleet.main.waitForEntry((entry) => entry.body === "result received", "the worker handoff");
  assert.deepEqual(receipts, [1, 1, 1]);
  assert.equal(readFileSync(marker, "utf8"), "executed\n");
  assert.deepEqual(await jobResults(), [[1, 0, "recovered"]]);
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  t.after(() => {
    db.close();
  });
  const reservations = db.prepare("SELECT id FROM jobs WHERE label = ?").all("recover");
  assert.deepEqual(
    reservations.map((row) => row["id"]),
    [1],
  );
});

test("run_long retries transient HTTP 400 writes with the same prepare and registration identity", async (t) => {
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  t.after(() => {
    db.close();
  });
  db.exec(`CREATE TRIGGER refuse_prepare BEFORE INSERT ON jobs WHEN NEW.label = 'recover-writes'
    BEGIN SELECT RAISE(ABORT, 'injected prepare write failure'); END;
    CREATE TRIGGER refuse_registration BEFORE UPDATE OF wrapper_pid ON jobs WHEN OLD.label = 'recover-writes'
    BEGIN SELECT RAISE(ABORT, 'injected registration write failure'); END;`);
  const prepares: unknown[] = [];
  const registrations: unknown[] = [];
  const refusals: { op: string; status: number }[] = [];
  await jobProxy(t, async (op, args) => {
    const result = await callCardd(op, args);
    if (op !== "job.prepare" && op !== "job.register") return result;
    const calls = op === "job.prepare" ? prepares : registrations;
    calls.push(args);
    if (calls.length === 1) {
      refusals.push({ op, status: result.status });
      db.exec(
        op === "job.prepare" ? "DROP TRIGGER refuse_prepare" : "DROP TRIGGER refuse_registration",
      );
    }
    return result;
  });
  const marker = join(jobDir, "executions");
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "recover-writes", command: `echo executed >> ${quote(marker)}; echo recovered` },
  }));
  h.onModel(() => ({ text: "Waiting for the recovered command" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "Write retries verified" } }));
  worker();
  await h.waitForCall(2);
  assert.ok(said("job 1 (recover-writes) in tab"));
  await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the recovered job result");
  assert.deepEqual(refusals, [
    { op: "job.prepare", status: 400 },
    { op: "job.register", status: 400 },
  ]);
  for (const calls of [prepares, registrations]) {
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  }
  assert.equal(db.prepare("SELECT count(*) AS count FROM jobs").get()?.["count"], 1);
  assert.equal(readFileSync(marker, "utf8"), "executed\n");
  assert.deepEqual(await jobResults(), [[1, 0, "recovered"]]);
});

for (const torn of [true, false]) {
  test(`an expired reservation cannot dispatch after ${torn ? "a torn prepare reply and replay" : "a stale prepare receipt"}`, async (t) => {
    const release = Promise.withResolvers<undefined>();
    t.after(() => {
      release.resolve(undefined);
    });
    const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
    t.after(() => {
      db.close();
    });
    const receipts: unknown[] = [];
    const marker = join(jobDir, "ran-after-fence");
    await jobProxy(t, async (op, args) => {
      const result = await callCardd(op, args);
      if (op !== "job.prepare") return result;
      const outcome = check(HttpOutcomeSchema, result.body);
      assert.ok(outcome.ok);
      const receipt = check(OPS["job.prepare"].result, outcome.value);
      receipts.push(receipt);
      if (receipts.length !== 1) return result;
      db.prepare("UPDATE jobs SET created_at = created_at - 60000 WHERE id = ?").run(receipt.job);
      await release.promise;
      return torn ? { ...result, body: '{"ok":true,"value":' } : result;
    });
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "expired", command: `touch ${quote(marker)}` },
    }));
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "Expiry observed" } }));
    const initialTabs = await tabsInWorkspace();
    worker();
    await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the early fence");
    assert.deepEqual(await tabsInWorkspace(), initialTabs);
    release.resolve(undefined);
    await h.waitForCall(2);
    assert.ok(said("Job 1 cannot start:"));
    assert.equal(said("Started job 1"), false);
    assert.equal(receipts.length, torn ? 2 : 1);
    if (torn)
      assert.deepEqual(receipts[1], {
        job: 1,
        unavailable:
          "already finished: could not start: wrapper did not register before the startup deadline",
      });
    assert.deepEqual(
      (await tabsInWorkspace()).map((tab) => tab["tab_id"]),
      initialTabs.map((tab) => tab["tab_id"]),
    );
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await jobResults(), [
      [1, 127, "could not start: wrapper did not register before the startup deadline"],
    ]);
  });
}

for (const registrationFirst of [false, true]) {
  test(`stop_job ${registrationFirst ? "signals the pinned wrapper" : "fences the reservation"} while registration is in flight`, async (t) => {
    const waiting = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    t.after(() => {
      release.resolve(undefined);
    });
    const registered = Promise.withResolvers<boolean>();
    const disconnect = await jobProxy(t, async (op, args) => {
      if (op !== "job.register") return callCardd(op, args);
      if (!registrationFirst) {
        waiting.resolve(undefined);
        await release.promise;
      }
      const result = await callCardd(op, args);
      const outcome = check(HttpOutcomeSchema, result.body);
      assert.ok(outcome.ok);
      registered.resolve(check(OPS["job.register"].result, outcome.value).registered);
      if (registrationFirst) {
        waiting.resolve(undefined);
        await release.promise;
      }
      return result;
    });
    let decoy: unknown;
    if (registrationFirst) {
      await lab.run([
        "tab",
        "create",
        "--workspace",
        workspace(),
        "--label",
        "job-1-stopping",
        "--no-focus",
      ]);
      decoy = (await tabsInWorkspace()).find((tab) => tab["label"] === "job-1-stopping")?.[
        "tab_id"
      ];
      assert.equal(typeof decoy, "string");
    }
    const marker = join(jobDir, "unexpected-execution");
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "stopping", command: `touch ${quote(marker)}` },
    }));
    h.onModel(async () => {
      await waiting.promise;
      if (registrationFirst) {
        disconnect();
        await h.waitForNth(
          (event) => event["type"] === "fleet_connected",
          2,
          "the worker to resync running jobs",
        );
      }
      return { tool: "stop_job", args: { job: 1 } };
    });
    h.onModel(() => ({ text: "Stop requested" }));
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "Stop verified" } }));
    worker();
    await h.waitForCall(2);
    assert.ok(said(registrationFirst ? "Sent a stop to job 1" : "Its command will not run"));
    if (!registrationFirst) {
      await waitTabGone("job-1-stopping");
    }
    release.resolve(undefined);
    assert.equal(await registered.promise, registrationFirst);
    const output = registrationFirst ? "interrupted" : "stopped before wrapper registration";
    await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the job result");
    assert.deepEqual(await jobResults(), [[1, 130, output]]);
    assert.equal(existsSync(marker), false);
    if (registrationFirst)
      assert.ok((await tabsInWorkspace()).some((tab) => tab["tab_id"] === decoy));
  });
}
