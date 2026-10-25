import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let jobDir: string;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  jobDir = join(h.dir, "jobs");
  mkdirSync(jobDir);
  env = { ...env, HERDR_SESSION: lab.name, HERDR_WORKSPACE_ID: workspace, TMPDIR: jobDir };
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const worker = (): Pi => h.startPi("c-1-a1", env, [EXTENSION]);
const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
const said = (text: string): boolean =>
  h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));
const settled = (n: number) =>
  h.waitForNth((e) => e["type"] === "settled", n, `settle ${String(n)}`);

test("a run_long result wakes the worker, and the wait is not a stall", async () => {
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "tests", command: "echo one; echo two; exit 3" },
  }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "two tests fail" } }));
  worker();
  await fleet.main.waitForEntries(1);

  assert.equal(
    lastUser(await h.waitForCall(2)),
    "[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 3: one\ntwo",
  );
  assert.ok(said("Started job 1 (tests) in tab job-1-tests."));
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [["failed", "two tests fail"]],
  );
  const tabs = records(
    (await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]))["tabs"],
  );
  assert.ok(tabs.some((tab) => tab["label"] === "job-1-tests"));
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

function pids(text: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", text], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

const findings = (): string[] =>
  fleet.main.entries.filter(({ entry }) => entry.kind === "finding").map(({ entry }) => entry.body);

const commandAwaitingGo = (n: number): { command: string; ready: string; go: string } => {
  const ready = join(h.dir, `ready-${String(n)}`);
  const go = join(h.dir, `go-${String(n)}`);
  const command = `touch ${ready}; while [ ! -f ${go} ]; do sleep 0.1; done; echo late`;
  return { command, ready, go };
};

const wrapperOf = async (job: number, ready: string): Promise<number> => {
  await until(() => (existsSync(ready) ? true : undefined), "the job to start");
  const [wrapper] = pids(join(jobDir, `fleet-job-${String(job)}-`));
  assert.ok(wrapper !== undefined);
  return wrapper;
};

test("a job whose wrapper died is lost once: the mate and the worker are told", async () => {
  const first = commandAwaitingGo(1);
  const second = commandAwaitingGo(2);
  h.onModel(() => ({ tool: "run_long", args: { label: "first", command: first.command } }));
  h.onModel(() => ({ text: "waiting for the first job" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the first job is lost" } }));
  h.onModel(() => ({ text: "done" }));
  h.onModel(() => ({ tool: "run_long", args: { label: "second", command: second.command } }));
  h.onModel(() => ({ text: "waiting for the second job" }));
  try {
    worker();
    process.kill(await wrapperOf(1, first.ready), "SIGKILL");
    await until(() => (findings().length > 0 ? true : undefined), "the finding");
    assert.deepEqual(
      findings().map((body) => body.slice(0, 22)),
      ["job lost: job 1 (first"],
    );
    assert.match(
      lastUser(await h.waitForCall(3)) ?? "",
      /^\[fleet\] c-1 users-see-one-scrollbar job 1 \(first\) lost: no heartbeat arrived/,
    );
    const reported = (): boolean => fleet.main.entries.some(({ entry }) => entry.kind === "report");
    await until(() => (reported() ? true : undefined), "the worker's report");
    assert.equal(await status(fleet.main, card), "with-mate");

    await fleet.main.call("comment", { card: card.id, text: "run another job" });
    process.kill(await wrapperOf(2, second.ready), "SIGKILL");
    await until(() => (findings().length > 1 ? true : undefined), "the second finding");
    assert.deepEqual(
      findings().map((body) => body.slice(0, 22)),
      ["job lost: job 1 (first", "job lost: job 2 (secon"],
    );
  } finally {
    writeFileSync(first.go, "");
    writeFileSync(second.go, "");
  }
});

test("a result that arrives after the job was marked lost is still delivered once", async () => {
  const slow = commandAwaitingGo(3);
  h.onModel(() => ({ tool: "run_long", args: { label: "late", command: slow.command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the job is lost" } }));
  h.onModel(() => ({ text: "done" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "the job ended after all" } }));
  worker();
  const wrapper = await wrapperOf(1, slow.ready);
  process.kill(wrapper, "SIGSTOP");
  try {
    await until(() => (findings().length > 0 ? true : undefined), "the finding");
    assert.match(
      lastUser(await h.waitForCall(3)) ?? "",
      /^\[fleet\] c-1 users-see-one-scrollbar job 1 \(late\) lost: no heartbeat arrived/,
    );
    await until(
      () => (fleet.main.entries.some(({ entry }) => entry.kind === "report") ? true : undefined),
      "the worker's report",
    );
    writeFileSync(slow.go, "");
  } finally {
    process.kill(wrapper, "SIGCONT");
  }

  const after = await until(
    () => h.calls.find((turns) => lastUser(turns)?.includes("exited 0") === true),
    "the result",
  );
  assert.equal(lastUser(after), "[fleet] c-1 users-see-one-scrollbar job 1 (late) exited 0: late");
  assert.equal(after.filter((turn) => turn.text.includes("exited 0")).length, 1);
});

test("a job marked lost while its wrapper is only stalled stays tracked after it beats again", async () => {
  const slow = commandAwaitingGo(4);
  const delivered = (): number =>
    h.events.filter((event) => event["type"] === "fleet_delivered").length;
  h.onModel(() => ({ tool: "run_long", args: { label: "stalled", command: slow.command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  const wrapper = { pid: 0 };
  h.onModel(async () => {
    const lostDelivered = delivered();
    process.kill(wrapper.pid, "SIGCONT");
    await until(() => (delivered() > lostDelivered ? true : undefined), "revival");
    return { text: "still waiting" };
  });
  for (let i = 0; i < 4; i++)
    h.onModel((turns) =>
      lastUser(turns)?.includes("exited 0") === true
        ? { text: "the job ended" }
        : { text: "still waiting" },
    );
  worker();
  wrapper.pid = await wrapperOf(1, slow.ready);
  process.kill(wrapper.pid, "SIGSTOP");
  try {
    await until(() => (said("job 1 (stalled) is running again") ? true : undefined), "revival");
  } finally {
    process.kill(wrapper.pid, "SIGCONT");
  }
  const stopped = (): boolean =>
    fleet.main.entries.some(({ entry }) => entry.fields["status"] === "stopped");
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.equal(stopped(), false);

  writeFileSync(slow.go, "");
  await until(
    () => (said("Your run is ending without a handoff") ? true : undefined),
    "the nudge once the finished job is no longer tracked",
  );
});
