import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { type Card } from "@fleet/protocol";
import { status, type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import { jobHelpers, lastUser, until } from "../support/job-env.ts";
import type { Harness } from "../support/harness.ts";
import { type Turn } from "../support/harness.ts";
import type { HerdrLab } from "../support/herdr.ts";

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
  pastStartup();
});
afterEach(async (t) => {
  await jl.stop(t);
});
const { worker, findings, commandAwaitingGo, wrapperOf, pastStartup } = jobHelpers(current);

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
    assert.ok(
      (await h.waitForCall(3)).some(
        (turn) =>
          turn.role === "user" &&
          turn.text.startsWith(
            "[fleet] c-1 users-see-one-scrollbar job 1 (first) lost: its wrapper process is gone",
          ),
      ),
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

test("a live job that goes silent is not lost: the detector finds its wrapper alive and the job finishes", async () => {
  const quiet = commandAwaitingGo(5);
  h.onModel(() => ({ tool: "run_long", args: { label: "quiet", command: quiet.command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  for (let i = 0; i < 3; i++) h.onModel(() => ({ text: "noted" }));
  worker();
  const wrapper = await wrapperOf(1, quiet.ready);
  process.kill(wrapper, "SIGSTOP");
  try {
    await until(
      () => (jl.probe.count("live") >= 3 ? true : undefined),
      "the detector to find the silent wrapper alive three times",
    );
    assert.equal(jl.jobState(1), "running");
    assert.deepEqual(findings(), []);
  } finally {
    process.kill(wrapper, "SIGCONT");
    writeFileSync(quiet.go, "");
  }
  const after = await until(
    () => h.calls.find((turns) => lastUser(turns)?.includes("exited 0") === true),
    "the result",
  );
  assert.equal(lastUser(after), "[fleet] c-1 users-see-one-scrollbar job 1 (quiet) exited 0: late");
  assert.equal(jl.jobState(1), "finished");
  assert.deepEqual(findings(), []);
  assert.equal(
    h.calls.some((turns) => turns.some((turn) => turn.text.includes("lost:"))),
    false,
  );
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
  jl.probe.silence(wrapper);
  try {
    await until(() => (findings().length > 0 ? true : undefined), "the finding");
    assert.ok(
      (await h.waitForCall(3)).some(
        (turn) =>
          turn.role === "user" &&
          turn.text.startsWith(
            "[fleet] c-1 users-see-one-scrollbar job 1 (late) lost: its wrapper process is gone",
          ),
      ),
    );
    await until(
      () => (fleet.main.entries.some(({ entry }) => entry.kind === "report") ? true : undefined),
      "the worker's report",
    );
    writeFileSync(slow.go, "");
  } finally {
    jl.probe.resume(wrapper);
  }

  const after = await until(
    () => h.calls.find((turns) => lastUser(turns)?.includes("exited 0") === true),
    "the result",
  );
  assert.equal(lastUser(after), "[fleet] c-1 users-see-one-scrollbar job 1 (late) exited 0: late");
  assert.equal(after.filter((turn) => turn.text.includes("exited 0")).length, 1);
});

test("replayed lost and revival notices never change the tracked wait: only the finished job's result ends it", async () => {
  const slow = commandAwaitingGo(4);
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
  jl.probe.silence(wrapper);
  const lostCall = await callWith((text) => text.includes("lost:"));
  await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "runtime-failure",
    "the failed lost notice",
  );
  jl.probe.resume(wrapper);
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
  jl.probe.silence(wrapper);
  const secondLost = await callWith(
    (text) => text.includes("lost:") && !text.includes(again),
    replayedLost + 1,
  );
  await handled(secondLost);
  jl.probe.resume(wrapper);
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
