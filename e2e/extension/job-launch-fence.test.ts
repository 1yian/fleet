import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
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
  tabsInWorkspace,
  cardView,
  jobResults,
  cardReports,
  shim,
} = jobHelpers(current);
const jobProxy = makeJobProxy(current);

test("an explicit stop receipt that precedes the prepare receipt fences the launch before any tab exists", async (t) => {
  const prepareReply = Promise.withResolvers<undefined>();
  const fenceDelivery = Promise.withResolvers<undefined>();
  const stopGate = Promise.withResolvers<undefined>();
  t.after(() => {
    prepareReply.resolve(undefined);
    fenceDelivery.resolve(undefined);
    stopGate.resolve(undefined);
  });
  await jobProxy(
    t,
    async (op, args) => {
      const result = await callCardd(op, args);
      if (op === "job.prepare") {
        stopGate.resolve(undefined);
        await prepareReply.promise;
      }
      return result;
    },
    fenceDelivery.promise,
    undefined,
    undefined,
    stopGate.promise,
  );
  const dispatches = join(jobDir, "dispatches");
  const tabs = join(jobDir, "tab-requests");
  const marker = join(jobDir, "unexpected-execution");
  shim(
    (herdr) => `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  echo dispatch >> ${quote(dispatches)}
fi
if [ "$1 $2" = 'tab create' ]; then
  echo tab >> ${quote(tabs)}
fi
exec ${quote(herdr)} "$@"
`,
  );
  env["PROBE_STOP_RESULT"] = "1";
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "cancelled", command: `touch ${quote(marker)}` },
    alongside: [{ tool: "stop_job", args: { job: 1 } }],
  }));
  h.onModel(() => ({ text: "The launch was stopped" }));
  worker();
  const stopped = await h.waitFor(
    (event) => event["type"] === "stop_result",
    "the stop to be confirmed before the prepare receipt",
  );
  assert.deepEqual(stopped["content"], [
    {
      type: "text",
      text: "job 1 (cancelled) was stopped before wrapper registration. Its command will not run.",
    },
  ]);
  assert.equal(
    (await tabsInWorkspace()).some((each) => String(each["label"]).startsWith("job-1-")),
    false,
  );
  assert.equal(existsSync(tabs), false);
  prepareReply.resolve(undefined);
  await settled(1);
  assert.ok(said("Job 1 cannot start: it was stopped before dispatch"));
  assert.equal(said("Dispatched job 1"), false);
  assert.equal(said("Started job 1"), false);
  assert.equal(
    (await tabsInWorkspace()).some((each) => String(each["label"]).startsWith("job-1-")),
    false,
  );
  assert.equal(existsSync(tabs), false);
  assert.equal(existsSync(dispatches), false);
  assert.equal(existsSync(marker), false);
});

test("a legacy launcher failure never overwrites a committed loss that its worker has not yet received", async (t) => {
  const lossDelivery = Promise.withResolvers<undefined>();
  t.after(() => {
    lossDelivery.resolve(undefined);
  });
  await jobProxy(
    t,
    async (op, args) =>
      op === "job.prepare"
        ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
        : callCardd(op, args),
    lossDelivery.promise,
  );
  const dispatches = join(jobDir, "dispatches");
  const requested = join(jobDir, "tab-requested");
  const release = join(jobDir, "release-tab");
  const marker = join(jobDir, "unexpected-execution");
  const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
  shim(
    (herdr) => `#!/bin/sh
if [ "$1 $2" = 'tab create' ]; then
  touch ${quote(requested)}
  node -e ${quote(waitForRelease)} || exit "$?"
  echo 'tab create unavailable' >&2
  exit 1
fi
if [ "$1 $2" = 'pane run' ]; then
  echo dispatch >> ${quote(dispatches)}
fi
exec ${quote(herdr)} "$@"
`,
  );
  t.after(() => {
    writeFileSync(release, "");
  });
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "doomed", command: `touch ${quote(marker)}` },
  }));
  h.onModel(() => ({ text: "The launch failed" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "The job is lost" } }));
  worker();
  await until(() => (existsSync(requested) ? true : undefined), "the launch to reach tab creation");
  const lost = await untilAsync(
    async () =>
      (await cardView()).entries.find(
        (entry) => entry.kind === "job-result" && entry.fields["lost"] === true,
      ),
    "cardd to commit the loss",
  );
  assert.equal(
    h.events.some((event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id),
    false,
  );
  writeFileSync(release, "");
  await settled(1);
  assert.ok(said("tab create unavailable"));
  assert.deepEqual(
    (await cardView()).entries
      .filter((entry) => entry.kind === "job-result")
      .map((entry) => [entry.fields["lost"], entry.fields["exitCode"]]),
    [[true, undefined]],
  );
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  t.after(() => {
    db.close();
  });
  assert.deepEqual(
    { ...db.prepare("SELECT state, exit_code FROM jobs WHERE id = 1").get() },
    {
      state: "lost",
      exit_code: null,
    },
  );
  lossDelivery.resolve(undefined);
  await until(
    () =>
      said("[fleet] c-1 users-see-one-scrollbar job 1 (doomed) lost: no heartbeat arrived")
        ? true
        : undefined,
    "the loss to reach the worker after the launcher failed",
  );
  assert.equal(existsSync(dispatches), false);
  assert.equal(existsSync(marker), false);
});

test("run_long reports a dispatch as awaiting startup confirmation while registration is held, then delivers the result", async (t) => {
  const registration = Promise.withResolvers<undefined>();
  let registering = false;
  t.after(() => {
    registration.resolve(undefined);
  });
  await jobProxy(t, async (op, args) => {
    if (op === "job.register") {
      registering = true;
      await registration.promise;
    }
    return callCardd(op, args);
  });
  h.onModel(() => ({ tool: "run_long", args: { label: "held", command: "echo held-ok" } }));
  h.onModel(() => ({ text: "Waiting for the command" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "The held job ran" } }));
  worker();
  await h.waitForCall(1);
  assert.ok(
    said(
      "Dispatched job 1 (held) in tab job-1-held; its startup is not yet confirmed. Its result, or a failure to start, arrives as a [fleet] message",
    ),
  );
  assert.equal(said("Started job 1"), false);
  await until(() => (registering ? true : undefined), "the wrapper to request registration");
  assert.deepEqual(await jobResults(), []);
  registration.resolve(undefined);
  await fleet.main.waitForEntry((entry) => entry.body === "The held job ran", "the worker handoff");
  assert.deepEqual(await jobResults(), [[1, 0, "held-ok"]]);
});

test("an unknown idle verdict skips the nudge and the automatic stop, and a later confirmed idle run gets both", async (t) => {
  let unknown = true;
  let reportCalls = 0;
  await jobProxy(
    t,
    callCardd,
    false,
    undefined,
    (reply) => {
      reportCalls += 1;
      return reply;
    },
    undefined,
    (reply) =>
      unknown ? { t: "result", id: reply.id, ok: false, error: "idle verdict unavailable" } : reply,
  );
  h.onModel(() => ({ text: "Nothing is running." }));
  const pi = worker();
  await settled(1);
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.equal(reportCalls, 0);
  assert.deepEqual(await cardReports(), []);
  assert.equal(await status(fleet.main, card), "working");

  unknown = false;
  h.onModel(() => ({ text: "Still nothing is running." }));
  h.onModel(() => ({ text: "Confirmed idle, nothing to report." }));
  pi.prompt("Check again");
  await fleet.main.waitForEntry(
    (entry) => entry.kind === "report" && entry.fields["status"] === "stopped",
    "the stopped handoff after a confirmed idle nudge",
  );
  assert.ok(said("Your run is ending without a handoff"));
  assert.deepEqual(await cardReports(), [
    ["stopped", "ended the run without a handoff: Confirmed idle, nothing to report."],
  ]);
});

test("a failed job-file write cannot hand off as stopped until cardd fences the reservation", async (t) => {
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  t.after(() => {
    db.close();
  });
  db.exec(`CREATE TRIGGER refuse_startup_result BEFORE UPDATE ON jobs
    WHEN OLD.label = 'pre-dispatch' AND NEW.state = 'finished'
    BEGIN SELECT RAISE(ABORT, 'startup result unavailable'); END;`);
  let reportCalls = 0;
  await jobProxy(t, callCardd, false, undefined, (reply) => {
    reportCalls += 1;
    return reply;
  });
  const marker = join(h.dir, "unexpected-execution");
  h.onModel(() => {
    rmSync(jobDir, { recursive: true });
    return { tool: "run_long", args: { label: "pre-dispatch", command: `touch ${quote(marker)}` } };
  });
  h.onModel(() => ({ text: "The job failed to start." }));
  worker();
  await settled(1);
  assert.equal(reportCalls, 0);
  assert.ok(said("ENOENT"));
  assert.equal(said("Your run is ending without a handoff"), false);
  db.prepare("UPDATE jobs SET created_at = created_at - 60000 WHERE id = 1").run();
  await until(
    () =>
      fleet.cardd.errors.includes("Could not expire job startups: startup result unavailable")
        ? true
        : undefined,
    "cardd to attempt expiry while writes fail",
  );
  const job = db.prepare("SELECT state, wrapper_pid FROM jobs WHERE id = 1");
  assert.deepEqual({ ...job.get() }, { state: "running", wrapper_pid: null });
  assert.deepEqual(await jobResults(), []);
  assert.deepEqual(await cardReports(), []);
  assert.equal(await status(fleet.main, card), "working");

  h.onModel(() => ({ text: "Cardd fenced the failed launch." }));
  h.onModel(() => ({ text: "Nothing else to report." }));
  db.exec("DROP TRIGGER refuse_startup_result");
  await fleet.main.waitForEntry(
    (entry) => entry.fields["status"] === "stopped",
    "the stopped handoff after the reservation is fenced",
  );
  assert.ok(said("Your run is ending without a handoff"));
  const view = await cardView();
  assert.deepEqual(
    view.entries
      .filter((entry) => entry.kind === "job-result")
      .map((entry) => [entry.fields["startupFenced"], entry.fields["exitCode"], entry.body]),
    [[true, 127, "could not start: wrapper did not register before the startup deadline"]],
  );
  assert.ok(said("could not start: wrapper did not register before the startup deadline"));
  assert.deepEqual(await cardReports(), [
    ["stopped", "ended the run without a handoff: Nothing else to report."],
  ]);
  assert.equal(existsSync(marker), false);
});

test("an automatic stop committed before its reply was lost is not replayed on reconnect", async (t) => {
  let lists = 0;
  const disconnect = await jobProxy(
    t,
    callCardd,
    false,
    (reply) => {
      lists += 1;
      return reply;
    },
    (reply) => {
      assert.ok(reply.ok);
      assert.equal(check(OPS.report.result, reply.value).status, "with-mate");
      return undefined;
    },
  );
  h.onModel(() => ({ text: "The investigation is incomplete." }));
  h.onModel(() => ({ text: "No further work this turn." }));
  worker();
  const body = "ended the run without a handoff: No further work this turn.";
  await fleet.main.waitForEntry(
    (entry) => entry.kind === "report" && entry.body === body,
    "the first automatic stop to reach the mate",
  );
  await untilAsync(
    async () => ((await cardView()).card.activity?.state === "idle" ? true : undefined),
    "the worker to settle after the missing reply times out",
  );
  const beforeReconnect = lists;
  disconnect();
  await until(
    () => (lists > beforeReconnect ? true : undefined),
    "the worker to refresh jobs after reconnecting",
  );
  assert.deepEqual(await cardReports(), [["stopped", body]]);
  assert.equal(await status(fleet.main, card), "with-mate");
});
