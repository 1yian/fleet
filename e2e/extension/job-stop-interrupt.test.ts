import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type ServerMessage } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { JobLab } from "../support/job-lab.ts";
import { records } from "../support/json.ts";
import { until } from "../support/live-fleet.ts";

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

async function legacyGate(t: Parameters<typeof JobLab.prototype.proxy>[0]) {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const proxy = await jl.proxy(t);
  proxy.httpFault(
    "job.prepare",
    { status: 400, body: { ok: false, error: "unknown operation job.prepare" } },
    1,
  );
  const shim = jl.installShim();
  writeFileSync(shim.release, "");
  const done = join(jl.jobDir, "gate-done");
  jl.h.onModel(() => ({
    tool: "run_long",
    args: {
      label: "gate",
      command: `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
    },
  }));
  jl.h.onModel(() => ({ text: "The gate is running" }));
  const pi = jl.worker();
  await until(
    () => (proxy.activities.includes("waiting") ? true : undefined),
    "the legacy job's wait",
  );
  return { pi, proxy, shim, done };
}

const gateTab = async () => (await jl.tabs()).find((tab) => tab["label"] === "job-1-gate");

test("a legacy stop reply that crosses the job's exit does not interrupt a same-named replacement tab", async (t) => {
  const { pi, proxy, shim, done } = await legacyGate(t);
  const stopReply = Promise.withResolvers<undefined>();
  const captured = Promise.withResolvers<ServerMessage>();
  t.after(() => stopReply.resolve(undefined));
  proxy.callFault("job.stop", { hold: stopReply.promise, seen: (m) => captured.resolve(m) });
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop reply arrived" }));
  pi.prompt("Stop the gate job");
  const reply = await captured.promise;
  assert.ok(reply.t === "result" && reply.ok);
  assert.deepEqual(check(OPS["job.stop"].result, reply.value), {
    label: "gate",
    running: true,
    legacy: true,
  });

  writeFileSync(done, "");
  const exit = await until(
    async () =>
      check(CardViewSchema, await jl.fleet.main.call("card", { card: jl.card.id })).entries.find(
        (entry) => entry.kind === "job-result" && entry.fields["exitCode"] === 0,
      ),
    "the legacy job's exit",
  );
  await jl.h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === exit.id,
    "the exit to reach the worker before the held stop reply",
  );
  await until(async () => ((await gateTab()) === undefined ? true : undefined), "the tab to close");
  await jl.lab.run([
    "tab",
    "create",
    "--workspace",
    jl.env["HERDR_WORKSPACE_ID"] ?? "",
    "--label",
    "job-1-gate",
    "--no-focus",
  ]);
  stopReply.resolve(undefined);
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the delayed running stop reply",
  );
  assert.equal(stopped["isError"], false);
  assert.deepEqual(stopped["content"], [
    {
      type: "text",
      text: "job 1 (gate): no interrupt was sent, and this reply was superseded by newer news about the job.",
    },
  ]);
  assert.equal(existsSync(shim.keys), false);
  assert.ok(await gateTab());
});

test("a legacy stop with no crossing news still interrupts its exact pane", async (t) => {
  const { pi, shim } = await legacyGate(t);
  const tab = await gateTab();
  assert.ok(tab);
  const panes = await jl.lab.run([
    "pane",
    "list",
    "--workspace",
    jl.env["HERDR_WORKSPACE_ID"] ?? "",
  ]);
  const pane = records(panes["panes"]).find((each) => each["tab_id"] === tab["tab_id"]);
  assert.ok(pane);
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop was sent" }));
  pi.prompt("Stop the gate job");
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the running stop reply",
  );
  assert.equal(stopped["isError"], false);
  assert.deepEqual(stopped["content"], [
    {
      type: "text",
      text: "Sent a stop to job 1 (gate). Its result arrives as a [fleet] message, exited 130 when the stop took.",
    },
  ]);
  assert.deepEqual(readFileSync(shim.keys, "utf8").trim().split("\n"), [String(pane["pane_id"])]);
});
