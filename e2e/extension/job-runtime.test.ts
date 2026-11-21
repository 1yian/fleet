import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type Card } from "@fleet/protocol";
import { type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import { jobHelpers, lastUser, pids, makeJobProxy, until } from "../support/job-env.ts";
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
const {
  worker,
  said,
  settled,
  callCardd,
  workspace,
  tabsInWorkspace,
  jobResults,
  commandAwaitingGo,
  findings,
} = jobHelpers(current);
const jobProxy = makeJobProxy(current);

test("a run_long job runs with the worker's scratch folder, temp folder, and compile cache, not the host's defaults", async () => {
  const scratch = join(h.dir, "card");
  const cache = join(h.dir, "cache");
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  env = {
    ...env,
    FLEET_SCRATCH: scratch,
    TMPDIR: join(scratch, "tmp"),
    NODE_COMPILE_CACHE: cache,
  };
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "tests", command: 'echo "$FLEET_SCRATCH $TMPDIR $NODE_COMPILE_CACHE"' },
  }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "seen" } }));
  worker();
  await fleet.main.waitForEntries(1);
  assert.equal(
    lastUser(await h.waitForCall(2)),
    `[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 0: ${scratch} ${join(scratch, "tmp")} ${cache}`,
  );
});

test("a finished job releases its tab while a running job's tab stays", async () => {
  const slow = commandAwaitingGo(9);
  h.onModel(() => ({ tool: "run_long", args: { label: "quick", command: "echo fast" } }));
  h.onModel(() => ({ tool: "run_long", args: { label: "slow", command: slow.command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "seen" } }));
  try {
    worker();
    await until(() => (existsSync(slow.ready) ? true : undefined), "the slow job to start");
    const labels = async (): Promise<unknown[]> =>
      records(
        (await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]))["tabs"],
      ).map((tab) => tab["label"]);
    const deadline = Date.now() + 10_000;
    while ((await labels()).includes("job-1-quick") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await labels(), ["1", "job-2-slow"]);
  } finally {
    writeFileSync(slow.go, "");
  }
});

test("a job keeps running across a worker restart, and its result arrives once", async () => {
  const counter = join(h.dir, "runs");
  const go = join(h.dir, "go");
  const command = `echo run >> ${counter}; while [ ! -f ${go} ]; do sleep 0.1; done; echo finished`;
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  const first = worker();
  await settled(1);
  await first.kill();
  writeFileSync(go, "");

  worker();
  await h.waitForNth((e) => e["type"] === "fleet_delivered", 2, "the job result after the restart");
  const after = await h.waitForCall(2);
  assert.equal(
    lastUser(after),
    "[fleet] c-1 users-see-one-scrollbar job 1 (wait) exited 0: finished",
  );
  assert.equal(
    after.filter((turn) => turn.text.startsWith("[fleet] c-1 users-see-one-scrollbar job 1"))
      .length,
    1,
  );
  assert.equal(existsSync(counter) ? readFileSync(counter, "utf8") : "", "run\n");
});

for (const kind of ["legacy", "registered", "replaced connection"] as const) {
  test(`stop after reload refuses a ${kind} job without its exact tab ID`, async (t) => {
    const legacy = kind === "legacy";
    if (kind !== "registered") {
      await jobProxy(t, async (op, args) => {
        if (legacy && op === "job.prepare")
          return { status: 400, body: { ok: false, error: "unknown operation job.prepare" } };
        if (kind === "replaced connection") {
          if (op === "job.cutover")
            return {
              status: 400,
              close: true,
              body: { ok: false, error: "unknown operation job.cutover" },
            };
          if (op === "job.stop")
            return { status: 200, body: { ok: true, value: { label: "reload", running: true } } };
        }
        return callCardd(op, args);
      });
    }
    const { ready, go, command } = commandAwaitingGo(27);
    h.onModel(() => ({ tool: "run_long", args: { label: "reload", command } }));
    h.onModel(() => ({ text: "Waiting for the job" }));
    const pi = worker();
    await until(() => (existsSync(ready) ? true : undefined), "the job command to start");
    await settled(1);
    const tab = (await tabsInWorkspace()).find((each) => each["label"] === "job-1-reload")?.[
      "tab_id"
    ];
    assert.ok(typeof tab === "string");
    if (!legacy) {
      await lab.run(["tab", "rename", tab, "actual-job"]);
      await lab.run([
        "tab",
        "create",
        "--workspace",
        workspace(),
        "--label",
        "job-1-reload",
        "--no-focus",
      ]);
    }
    pi.prompt("/probe-reload");
    await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "the worker to reload");
    h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
    h.onModel(() => ({ text: "Stop attempted" }));
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "Reload test finished" } }));
    pi.prompt("Stop the job after reloading");
    await h.waitForCall(3);
    assert.ok(said("has no verified tab ID in this worker session, so nothing was signalled"));
    assert.equal(said("Sent a stop to job 1 (reload)"), false);
    assert.ok(
      (await tabsInWorkspace()).some(
        (each) =>
          each["tab_id"] === tab && each["label"] === (legacy ? "job-1-reload" : "actual-job"),
      ),
    );
    assert.ok((await tabsInWorkspace()).some((each) => each["label"] === "job-1-reload"));
    assert.deepEqual(await jobResults(), []);
    writeFileSync(go, "");
    await h.waitForNth(
      (event) => event["type"] === "fleet_delivered",
      2,
      "the untouched job's result",
    );
    assert.deepEqual(await jobResults(), [[1, 0, "late"]]);
  });
}

const uniqueSleepSeconds = (n: number): string => `4${String(process.pid)}${String(n)}`;

test("a timeout kills the whole command, exits 124, and leaves nothing behind", async () => {
  const command = `sleep ${uniqueSleepSeconds(1)} & wait`;
  h.onModel(() => ({ tool: "run_long", args: { label: "slow", command, timeout_minutes: 0.02 } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "it timed out" } }));
  worker();
  await fleet.main.waitForEntries(1);

  assert.match(
    lastUser(await h.waitForCall(2)) ?? "",
    /^\[fleet\] c-1 users-see-one-scrollbar job 1 \(slow\) exited 124:/,
  );
  await until(
    () => (pids(uniqueSleepSeconds(1)).length === 0 ? true : undefined),
    "the sleep to be gone",
  );
});

test("a carriage return ends a line, and an endless line is cut to its last 2000 characters", async () => {
  const command = `printf 'x\\ry\\r\\n'; head -c 5000 /dev/zero | tr '\\0' a`;
  h.onModel(() => ({ tool: "run_long", args: { label: "progress", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "seen" } }));
  worker();
  await fleet.main.waitForEntries(1);

  const expected = `[fleet] c-1 users-see-one-scrollbar job 1 (progress) exited 0: x\ny\n${"a".repeat(2000)}`;
  assert.equal(lastUser(await h.waitForCall(2)), expected);
});

test("a command that ignores SIGTERM is killed when the grace ends", async () => {
  const command = `(trap '' TERM; exec sleep ${uniqueSleepSeconds(5)}) & wait`;
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "stubborn", command, timeout_minutes: 0.01 },
  }));
  h.onModel(() => ({ text: "waiting" }));
  try {
    worker();
    const woken = await h.waitForCall(2, "default", 30_000);
    assert.match(
      lastUser(woken) ?? "",
      /^\[fleet\] c-1 users-see-one-scrollbar job 1 \(stubborn\) exited 124:/,
    );
    assert.deepEqual(pids(uniqueSleepSeconds(5)), []);
  } finally {
    for (const pid of pids(uniqueSleepSeconds(5))) process.kill(pid, "SIGKILL");
  }
});

test("an interrupted job reports exit 130, with the unfinished line before it", async () => {
  const ready = join(h.dir, "ready");
  const command = `echo started; printf partial; touch ${ready}; sleep ${uniqueSleepSeconds(2)}`;
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "interrupted" } }));
  worker();
  await until(() => (existsSync(ready) ? true : undefined), "the job to start");
  const [wrapper] = pids(join(jobDir, "fleet-job-1-"));
  assert.ok(wrapper !== undefined);
  process.kill(wrapper, "SIGINT");
  await fleet.main.waitForEntries(1);

  assert.equal(
    lastUser(await h.waitForCall(2)),
    "[fleet] c-1 users-see-one-scrollbar job 1 (wait) exited 130: started\npartial\ninterrupted",
  );
  await until(
    () => (pids(uniqueSleepSeconds(2)).length === 0 ? true : undefined),
    "the sleep to be gone",
  );
});

test("closing the job tab still reaches the worker: the result, or a lost job", async () => {
  const ready = join(h.dir, "ready-tab");
  const command = `trap 'echo dying; exit 3' TERM; echo started; touch ${ready}; sleep ${uniqueSleepSeconds(6)} & wait`;
  h.onModel(() => ({ tool: "run_long", args: { label: "tab", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the tab was closed" } }));
  try {
    worker();
    await until(() => (existsSync(ready) ? true : undefined), "the job to start");
    const listed = await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]);
    const tab = records(listed["tabs"]).find((each) => each["label"] === "job-1-tab");
    assert.equal(typeof tab?.["tab_id"], "string");
    await lab.run(["tab", "close", String(tab?.["tab_id"])]);

    const woken = lastUser(await h.waitForCall(2, "default", 20_000)) ?? "";
    assert.ok(
      [
        "[fleet] c-1 users-see-one-scrollbar job 1 (tab) exited 130: started\ndying\ninterrupted",
        "[fleet] c-1 users-see-one-scrollbar job 1 (tab) lost: no heartbeat arrived. It is not run again.",
      ].includes(woken),
      woken,
    );
  } finally {
    for (const pid of pids(uniqueSleepSeconds(6))) process.kill(pid, "SIGKILL");
  }
});

test("a cardd stall longer than the keep-alive timeouts does not lose a live job", async () => {
  const { command, ready, go } = commandAwaitingGo(99);
  h.onModel(() => ({ tool: "run_long", args: { label: "stalled", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "finished" } }));
  worker();
  await until(
    () => (existsSync(ready) ? true : undefined),
    "the command to start after registration",
  );
  fleet.cardd.signal("SIGSTOP");
  await new Promise((resolve) => setTimeout(resolve, 6000));
  fleet.cardd.signal("SIGCONT");
  writeFileSync(go, "");

  const woken = lastUser(await h.waitForCall(2, "default", 30_000)) ?? "";
  assert.equal(woken, "[fleet] c-1 users-see-one-scrollbar job 1 (stalled) exited 0: late");
  assert.equal(said("no heartbeat"), false);
  assert.equal(
    findings().some((body) => body.includes("job lost")),
    false,
  );
});
