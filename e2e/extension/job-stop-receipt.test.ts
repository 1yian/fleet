import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type ServerMessage } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

test("a contradictory stop receipt changes nothing, and an honest receipt still stops the job", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const done = join(jl.jobDir, "gate-done");
  const { pi, proxy, shim, tab } = await jl.holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
  );
  writeFileSync(shim.release, "");
  await until(() => (jl.wrapperPid() === null ? undefined : true), "the wrapper to register");
  const mark = proxy.activities.length;
  const settles = (): number => jl.h.events.filter((event) => event["type"] === "settled").length;
  const contradictions = [
    { label: "gate", running: true, cancelled: true },
    { label: "gate", running: false, legacy: true },
    { label: "gate", running: false, cancelled: true, legacy: true },
    { label: "", running: false },
  ];
  let stops = 0;
  for (const receipt of contradictions) {
    const base = settles();
    proxy.callFault("job.stop", { value: receipt });
    jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
    jl.h.onModel(() => ({ text: "The stop receipt was refused" }));
    pi.prompt("Stop the gate job");
    stops += 1;
    const stopped = await jl.h.waitForNth(
      (event) => event["type"] === "stop_result",
      stops,
      "the contradictory stop receipt",
    );
    assert.equal(stopped["isError"], true);
    await jl.h.waitForNth(
      (event) => event["type"] === "settled",
      base + 1,
      "the worker to settle after the stop",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(shim.closes), false);
  assert.ok(await jl.hasTab(tab));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);
  assert.deepEqual(await jl.jobResults(), []);

  proxy.callFault("job.stop", undefined);
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop was sent" }));
  pi.prompt("Stop the gate job");
  const sent = await jl.h.waitForNth(
    (event) => event["type"] === "stop_result",
    stops + 1,
    "the honest stop receipt",
  );
  assert.equal(sent["isError"], false);
  await until(
    async () => ((await jl.jobResults()).length > 0 ? true : undefined),
    "the stopped job's result",
  );
  const [result] = await jl.jobResults();
  assert.deepEqual(result?.slice(0, 2), [1, 130]);
});

test("a generic stop receipt for a lost job keeps the pending dispatch reconcilable until an exact read answers", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const done = join(jl.jobDir, "gate-done");
  const { pi, proxy, shim } = await jl.holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
  );
  writeFileSync(shim.release, "");
  await until(() => (jl.wrapperPid() === null ? undefined : true), "the wrapper to register");
  proxy.callFault("job.running", { error: "injected exact read failure" });
  const wrapper = Number(jl.wrapperPid());
  process.kill(wrapper, "SIGSTOP");
  const resume = (): void => {
    try {
      process.kill(wrapper, "SIGCONT");
    } catch {
      return;
    }
  };
  t.after(resume);
  jl.ageJob(1);
  const lost = await until(
    async () =>
      check(CardViewSchema, await jl.fleet.main.call("card", { card: jl.card.id })).entries.find(
        (entry) => entry.fields["lost"] === true,
      ),
    "the detector to report the silent wrapper",
  );
  await jl.h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id,
    "the loss notice",
  );
  await until(
    () => (proxy.calls.includes("job.running") ? true : undefined),
    "the loss notice's exact read to be sent and fail",
  );
  const settles = (): number => jl.h.events.filter((event) => event["type"] === "settled").length;
  const checkFrom = proxy.activities.length;
  const checkBase = settles();
  jl.h.onModel(() => ({ text: "Still waiting on the lost job" }));
  pi.prompt("Check the gate job");
  await jl.h.waitForNth(
    (event) => event["type"] === "settled",
    checkBase + 1,
    "the worker to settle after the failed exact read",
  );
  const before = await until(
    () => proxy.activities.slice(checkFrom).findLast((state) => state !== "running"),
    "the worker's settled activity before the stop",
  );
  assert.equal(before, "waiting");
  const quiet = proxy.activities.length;
  const base = settles();
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The job is already lost" }));
  pi.prompt("Stop the gate job");
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the generic stop receipt",
  );
  assert.deepEqual(stopped["content"], [
    { type: "text", text: "job 1 (gate) is not running: nothing to stop." },
  ]);
  await jl.h.waitForNth(
    (event) => event["type"] === "settled",
    base + 1,
    "the worker to settle after the stop",
  );
  assert.equal(jl.jobState(1), "lost");
  const settledActivity = await until(
    () => proxy.activities.slice(quiet).findLast((state) => state !== "running"),
    "the stop turn's settled activity",
  );
  assert.equal(settledActivity, "idle");
  const reads = proxy.calls.filter((op) => op === "job.running").length;
  const mark = proxy.activities.length;
  proxy.callFault("job.running", undefined);
  proxy.drop();
  await until(
    () =>
      proxy.calls.filter((op) => op === "job.running").length > reads &&
      proxy.activities.slice(mark).includes("idle")
        ? true
        : undefined,
    "the reconnect's exact retry to be sent while the worker stays idle",
  );
});

test("a stop reply that is both a success and a failure leaves the held launch intact, and a real cancellation still cleans it up", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const { pi, proxy, shim, input, tab } = await jl.holdDispatch(t, "echo gate");
  assert.ok(existsSync(input));
  assert.ok(await jl.hasTab(tab));
  const mark = proxy.activities.length;
  const base = jl.h.events.filter((event) => event["type"] === "settled").length;
  proxy.callFault("job.stop", {
    local: {
      value: { label: "gate", running: false, cancelled: true },
      error: "ownership check failed",
    },
  });
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop reply was refused" }));
  pi.prompt("Stop the gate job");
  const refused = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the contradictory stop reply",
  );
  assert.equal(refused["isError"], true);
  await jl.h.waitForNth(
    (event) => event["type"] === "settled",
    base + 1,
    "the worker to settle after the refused reply",
  );
  assert.ok(existsSync(input));
  assert.equal(existsSync(shim.closes), false);
  assert.ok(await jl.hasTab(tab));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);
  assert.deepEqual(await jl.jobResults(), []);

  proxy.callFault("job.stop", undefined);
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The launch was cancelled" }));
  pi.prompt("Stop the gate job");
  const honest = await jl.h.waitForNth(
    (event) => event["type"] === "stop_result",
    2,
    "the honest stop reply",
  );
  assert.equal(honest["isError"], false);
  assert.deepEqual(honest["content"], [
    {
      type: "text",
      text: "job 1 (gate) was stopped before wrapper registration. Its command will not run.",
    },
  ]);
  await until(
    () => (existsSync(shim.closes) ? readFileSync(shim.closes, "utf8").trim() : undefined),
    "the cancelled launch's tab to close",
  );
  assert.equal(readFileSync(shim.closes, "utf8").trim(), tab);
  await until(
    async () => ((await jl.hasTab(tab)) ? undefined : true),
    "Herdr to stop listing the cancelled launch's tab",
  );
  assert.equal(existsSync(input), false);
  await until(
    async () => ((await jl.jobResults()).length > 0 ? true : undefined),
    "cardd to record the cancellation",
  );
  assert.deepEqual(await jl.jobResults(), [[1, 130, "stopped before wrapper registration"]]);
});

async function silenceRegisteredGate(
  t: Parameters<typeof JobLab.prototype.proxy>[0],
  proxy: Awaited<ReturnType<typeof JobLab.prototype.proxy>>,
  release: string,
) {
  writeFileSync(release, "");
  await until(() => (jl.wrapperPid() === null ? undefined : true), "the wrapper to register");
  const lists = proxy.lists();
  proxy.drop();
  await until(
    () => (proxy.lists() > lists ? true : undefined),
    "the reconnect list to confirm registration and release the pending dispatch",
  );
  proxy.callFault("job.running", { error: "injected exact read failure" });
  const wrapper = Number(jl.wrapperPid());
  process.kill(wrapper, "SIGSTOP");
  const resume = (): void => {
    try {
      process.kill(wrapper, "SIGCONT");
    } catch {
      return;
    }
  };
  t.after(resume);
  jl.ageJob(1);
  const entryWhere = (field: string) => async () =>
    check(CardViewSchema, await jl.fleet.main.call("card", { card: jl.card.id })).entries.find(
      (entry) => entry.fields[field] === true,
    );
  const lost = await until(entryWhere("lost"), "the detector to report the silent wrapper");
  await jl.h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id,
    "the loss notice",
  );
  return { resume, entryWhere };
}

test("a delayed generic stop reply for a lost job cannot discard a revival that arrived first", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const done = join(jl.jobDir, "gate-done");
  const { pi, proxy, shim } = await jl.holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
  );
  const { resume, entryWhere } = await silenceRegisteredGate(t, proxy, shim.release);

  const stopReply = Promise.withResolvers<undefined>();
  const exactReply = Promise.withResolvers<undefined>();
  t.after(() => {
    stopReply.resolve(undefined);
    exactReply.resolve(undefined);
  });
  const captured = Promise.withResolvers<ServerMessage>();
  proxy.callFault("job.stop", {
    hold: stopReply.promise,
    seen: (message) => captured.resolve(message),
  });
  const quiet = proxy.activities.length;
  const base = jl.h.events.filter((event) => event["type"] === "settled").length;
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop reply arrived" }));
  pi.prompt("Stop the gate job");
  await until(
    () => (proxy.calls.includes("job.stop") ? true : undefined),
    "the stop request to be sent",
  );
  const negative = await captured.promise;
  assert.ok(negative.t === "result" && negative.ok);
  assert.deepEqual(check(OPS["job.stop"].result, negative.value), {
    label: "gate",
    running: false,
  });
  proxy.callFault("job.running", { hold: exactReply.promise });
  resume();
  const revived = await until(entryWhere("revived"), "the heartbeat to revive the job");
  await jl.h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === revived.id,
    "the revival notice",
  );
  await until(
    () => (proxy.calls.filter((op) => op === "job.running").length > 1 ? true : undefined),
    "the revival's exact read to be requested",
  );
  const mark = proxy.activities.length;
  stopReply.resolve(undefined);
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the delayed generic stop reply",
  );
  assert.equal(stopped["isError"], false);
  assert.deepEqual(stopped["content"], [
    {
      type: "text",
      text: "job 1 (gate): no interrupt was sent, and this reply was superseded by newer news about the job.",
    },
  ]);
  await jl.h.waitForNth(
    (event) => event["type"] === "settled",
    base + 1,
    "the worker to settle after the stop",
  );
  const settledActivity = await until(
    () => proxy.activities.slice(mark).findLast((state) => state !== "running"),
    "the worker's settled activity",
  );
  assert.equal(settledActivity, "waiting");
  assert.equal(proxy.activities.slice(quiet).includes("idle"), false);
  exactReply.resolve(undefined);

  writeFileSync(done, "");
  await until(
    () => (proxy.activities.slice(mark).includes("idle") ? true : undefined),
    "the command's real result to end the wait",
  );
  assert.deepEqual((await jl.jobResults()).at(-1), [1, 0, "gate"]);
});
