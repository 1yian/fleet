import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const PGREP_READS = fileURLToPath(new URL("../support/pgrep-reads.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let jobDir: string;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  jobDir = join(h.dir, "jobs");
  mkdirSync(jobDir);
  env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
    TMPDIR: jobDir,
    FLEET_JOB_WATCH_MS: "500",
  };
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

const findings = (): string[] =>
  fleet.main.entries
    .filter(({ entry }) => entry.kind === "finding" && entry.fields["condition"] === "job-lost")
    .map(({ entry }) => entry.body);

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

function faultablePgrep(): { control: string; reads: () => string[] } {
  const dir = join(h.dir, "pgrep-reads");
  mkdirSync(dir);
  const control = join(dir, "fault");
  const real = execFileSync("sh", ["-c", "command -v pgrep"], { encoding: "utf8" }).trim();
  const wrapper = join(dir, "pgrep");
  const script = `export PGREP_ARGS=$(printf '%s\\n' "$@")\nexec node '${PGREP_READS}' '${control}' '${real}'\n`;
  writeFileSync(wrapper, `#!/bin/sh\n${script}`);
  chmodSync(wrapper, 0o755);
  env = { ...env, PATH: `${dir}:${process.env["PATH"] ?? ""}` };
  const reads = (): string[] =>
    existsSync(`${control}.log`)
      ? readFileSync(`${control}.log`, "utf8").split("\n").filter(Boolean)
      : [];
  return { control, reads };
}

test("a job whose process is alive but silent is not lost, and its result arrives once when it thaws", async () => {
  const slow = commandAwaitingGo(3);
  const { reads } = faultablePgrep();
  h.onModel(() => ({ tool: "run_long", args: { label: "late", command: slow.command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "the job ended after all" } }));
  worker();
  const wrapper = await wrapperOf(1, slow.ready);
  process.kill(wrapper, "SIGSTOP");
  try {
    await until(() => (reads().length >= 2 ? true : undefined), "two looks at the frozen job");
    assert.deepEqual(reads().slice(0, 2), ["whole", "whole"]);
    assert.deepEqual(findings(), []);
    assert.equal(said("lost:"), false);
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
  assert.equal(said("lost:"), false);
  assert.deepEqual(findings(), []);
});

test("a look at the process table that fails, is killed, or never answers loses no job, and the first whole look at a dead process does", async () => {
  const dead = commandAwaitingGo(5);
  const { control, reads } = faultablePgrep();
  h.onModel(() => ({ tool: "run_long", args: { label: "dead", command: dead.command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the job is lost" } }));
  try {
    worker();
    const wrapper = await wrapperOf(1, dead.ready);
    process.kill(wrapper, "SIGKILL");
    for (const fault of ["kill", "fail", "hang"]) {
      writeFileSync(control, fault);
      const seen = (): number => reads().filter((each) => each === fault).length;
      await until(() => (seen() >= 2 ? true : undefined), `two ${fault} looks`);
      assert.deepEqual(findings(), []);
    }
    assert.equal(said("lost:"), false);

    rmSync(control);
    await until(() => (findings().length > 0 ? true : undefined), "the finding");
    assert.deepEqual(
      findings().map((body) => body.slice(0, 22)),
      ["job lost: job 1 (dead)"],
    );
    assert.ok(
      (await h.waitForCall(3)).some(
        (turn) =>
          turn.role === "user" &&
          turn.text.startsWith(
            "[fleet] c-1 users-see-one-scrollbar job 1 (dead) lost: its process is gone",
          ),
      ),
    );
  } finally {
    writeFileSync(dead.go, "");
  }
});

test("replayed lost and revival notices, from a frozen job that a misread called gone, never change the tracked wait: only the finished job's result ends it", async () => {
  const slow = commandAwaitingGo(4);
  const { control } = faultablePgrep();
  writeFileSync(control, "none");
  const routing =
    "pi-tiers: no usable model for tier 'default' (anthropic/claude-opus-5-5 on anthropic: cooling)";
  const nudge = "Your run is ending without a handoff";
  const again = "(sent again: the turn that got it ended before it was taken in)";
  const settledCount = (): number => h.events.filter((event) => event["type"] === "settled").length;
  const atCall: number[] = [];
  const failing = { lost: true, revival: false };
  const intake = (turns: Turn[]): { text: string } | { fail: string } | undefined => {
    const text = lastUser(turns) ?? "";
    if (text.includes("lost:") && !text.includes(again) && failing.lost) {
      failing.lost = false;
      return { fail: routing };
    }
    if (text.includes("is running again") && !text.includes(again) && failing.revival) {
      failing.revival = false;
      return { fail: routing };
    }
    return undefined;
  };
  h.onModel(() => {
    atCall.push(settledCount());
    return { tool: "run_long", args: { label: "stalled", command: slow.command } };
  });
  h.onModel(() => {
    atCall.push(settledCount());
    return { text: "waiting for the job" };
  });
  for (let i = 0; i < 30; i++)
    h.onModel((turns) => {
      atCall.push(settledCount());
      return intake(turns) ?? { text: "still waiting" };
    });
  const callWith = (match: (text: string) => boolean, from = 0): Promise<number> =>
    until(() => {
      const found = h.calls.findIndex((turns, i) => i >= from && match(lastUser(turns) ?? ""));
      return found < 0 ? undefined : found;
    }, "a notice to reach the model");
  const handled = async (call: number): Promise<void> => {
    await until(() => ((atCall[call] ?? Infinity) < settledCount() ? true : undefined), "settle");
  };
  const nudges = (): number =>
    h.calls.filter((turns) => (lastUser(turns) ?? "").includes(nudge)).length;
  const stopped = (): boolean =>
    fleet.main.entries.some(({ entry }) => entry.fields["status"] === "stopped");

  worker();
  const wrapper = await wrapperOf(1, slow.ready);
  process.kill(wrapper, "SIGSTOP");
  const lostCall = await callWith((text) => text.includes("lost:"));
  await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "runtime-failure",
    "the failed lost notice",
  );
  process.kill(wrapper, "SIGCONT");
  const revival = await callWith((text) => text.includes("is running again"), lostCall);
  await handled(revival);
  const replayedLost = await callWith(
    (text) => text.includes("lost:") && text.includes(again),
    revival,
  );
  await handled(replayedLost);
  assert.equal(nudges(), 0);
  assert.equal(stopped(), false);

  failing.revival = true;
  process.kill(wrapper, "SIGSTOP");
  const secondLost = await callWith(
    (text) => text.includes("lost:") && !text.includes(again),
    replayedLost + 1,
  );
  await handled(secondLost);
  process.kill(wrapper, "SIGCONT");
  const failedRevival = await callWith((text) => text.includes("is running again"), secondLost);
  await handled(failedRevival);
  writeFileSync(slow.go, "");
  const result = await callWith((text) => text.includes("exited 0"), failedRevival);
  await handled(result);
  const resultNudge = await callWith((text) => text.includes(nudge), result);
  await handled(resultNudge);
  const baseline = nudges();
  const replayedRevival = await callWith(
    (text) => text.includes("is running again") && text.includes(again),
    result,
  );
  await handled(replayedRevival);
  await until(() => (nudges() > baseline ? true : undefined), "a fresh nudge after the replay");
});
