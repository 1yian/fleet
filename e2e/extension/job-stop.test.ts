import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

interface Crew {
  readonly card: Card;
  readonly h: Harness;
  readonly jobDir: string;
  readonly env: Record<string, string>;
}

let fleet: Fleet;
let lab: HerdrLab;
let first: Crew;
let second: Crew;

async function crew(title: string): Promise<Crew> {
  const h = await Harness.start();
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  const card = await newCard(fleet.main, title);
  const token = await begin(fleet.main, card, "run the tests");
  const jobDir = join(h.dir, "jobs");
  mkdirSync(jobDir);
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
    TMPDIR: jobDir,
  };
  return { card, h, jobDir, env };
}

beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
  lab = await HerdrLab.start({});
  first = await crew("Users see one scrollbar");
  second = await crew("Users see one footer");
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([
    lab.stop(),
    first.h.stop(),
    second.h.stop(),
    fleet.cardd.stop(),
  ]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const start = (member: Crew, session: string): Pi =>
  member.h.startPi(session, member.env, [EXTENSION]);
const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
const lastResult = (turns: Turn[]): string =>
  turns.findLast((turn) => turn.role === "toolResult")?.text ?? "";
const said = (member: Crew, text: string): boolean =>
  member.h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));

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
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleepSeconds = (n: number): string => `4${String(process.pid)}${String(n)}`;
const wrapperOf = (member: Crew, job: number): number[] =>
  pids(join(member.jobDir, `fleet-job-${String(job)}-`));

test("a worker stops only its own named job, and cannot stop another worker's", async () => {
  const readyFirst = join(first.h.dir, "ready");
  const readySecond = join(second.h.dir, "ready");
  const goSecond = join(second.h.dir, "go");
  const own = `echo started; touch ${readyFirst}; sleep ${sleepSeconds(1)}`;
  const neighbour = `touch ${readySecond}; while [ ! -f ${goSecond} ]; do sleep 0.1; done; echo finished`;

  first.h.onModel(() => ({ tool: "run_long", args: { label: "tests", command: own } }));
  first.h.onModel(() => ({ text: "waiting" }));
  first.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  first.h.onModel(() => ({ text: "stopping" }));
  first.h.onModel(() => ({ tool: "report", args: { status: "failed", text: "stopped" } }));

  second.h.onModel(() => ({ tool: "run_long", args: { label: "tests", command: neighbour } }));
  second.h.onModel(() => ({ text: "waiting" }));
  second.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  second.h.onModel(() => ({ text: "refused" }));
  second.h.onModel(() => ({ tool: "stop_job", args: { job: 2 } }));
  second.h.onModel(() => ({ tool: "stop_job", args: { job: 99 } }));
  second.h.onModel(() => ({ tool: "report", args: { status: "failed", text: "all handled" } }));

  try {
    start(first, "c-1-a1");
    await until(() => (existsSync(readyFirst) ? true : undefined), "the first job to start");
    start(second, "c-2-a1");
    await until(() => (existsSync(readySecond) ? true : undefined), "the second job to start");
    await first.h.waitForCall(1);
    await second.h.waitForCall(1);
    assert.equal(wrapperOf(first, 1).length, 1);
    assert.equal(wrapperOf(second, 2).length, 1);

    await fleet.main.call("comment", { card: second.card.id, text: "stop the first job" });
    assert.match(
      lastResult(await second.h.waitForCall(3)),
      /job 1 is not one of this worker's jobs/,
    );
    assert.equal(wrapperOf(first, 1).length, 1);
    assert.equal(pids(sleepSeconds(1)).length, 1);
    assert.equal(said(first, "exited"), false);

    await fleet.main.call("comment", { card: first.card.id, text: "stop your tests" });
    assert.equal(
      lastUser(await first.h.waitForCall(4)),
      "[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 130: started\ninterrupted",
    );
    await until(
      () => (pids(sleepSeconds(1)).length === 0 ? true : undefined),
      "the first job's sleep to be gone",
    );
    assert.equal(wrapperOf(second, 2).length, 1);
    assert.equal(said(second, "exited"), false);

    writeFileSync(goSecond, "");
    assert.equal(
      lastUser(await second.h.waitForCall(4)),
      "[fleet] c-2 users-see-one-footer job 2 (tests) exited 0: finished",
    );
    assert.match(lastResult(await second.h.waitForCall(5)), /job 2 \(tests\) is not running/);
    assert.match(
      lastResult(await second.h.waitForCall(6)),
      /job 99 is not one of this worker's jobs/,
    );
  } finally {
    writeFileSync(goSecond, "");
    for (const pid of pids(sleepSeconds(1))) process.kill(pid, "SIGKILL");
  }
});
