import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import type { Move } from "../support/harness.ts";
import { check, OPS } from "@fleet/protocol";
import { git } from "../support/remote.ts";
import {
  LiveFleet,
  NEW_CODE,
  lastUser,
  systemOf,
  until,
  type Worker,
} from "../support/live-fleet.ts";

const PAUSED_UNTIL = new Date(Date.now() + 3_600_000).toISOString();
const NOW_LINE = "reconnected on a new process";
const SAFE_POINT = "waiting for a safe point: its turn and any job finish first";

let fleet: LiveFleet;
beforeEach(async () => {
  fleet = await LiveFleet.start({ FLEET_MAINTENANCE_WAIT_MS: "25000" });
});
afterEach(async (t) => {
  await fleet.lab.printIfFailed(t);
  await fleet.stop();
});

const hold = (name: string): string =>
  `touch ${fleet.gate(`${name}-started`)}; while [ ! -f ${fleet.gate(`${name}-gate`)} ]; do sleep 0.1; done; touch ${fleet.gate(`${name}-finished`)}`;
const reached = (name: string, what: string): boolean => existsSync(fleet.gate(`${name}-${what}`));

const pause: Move = {
  tool: "report",
  args: { status: "paused", text: "waiting", until: PAUSED_UNTIL },
};

function script(): void {
  const jobCommand = `echo run >> ${fleet.gate("job-runs")}; ${hold("job")}; echo built`;
  for (let call = 0; call < 120; call += 1) {
    fleet.h.onModel((turns) => {
      const at = turns.findLastIndex((turn) => turn.role === "user");
      const done = turns.slice(at).filter((turn) => turn.role === "toolResult").length;
      const first = turns.find((turn) => turn.role === "user")?.text ?? "";
      const opening = turns.findIndex((turn) => turn.role === "user") === at;
      const plans: Record<string, readonly Move[]> = {
        "START-busy": [{ tool: "bash", args: { command: hold("busy") } }, pause],
        "START-job": [{ tool: "run_long", args: { label: "build", command: jobCommand } }],
        "START-paused": [pause],
      };
      const plan = opening
        ? (Object.entries(plans).find(([key]) => first.includes(key))?.[1] ?? [])
        : [pause];
      return plan[done] ?? { text: "ok" };
    }, "worker");
    fleet.h.onModel((turns) => {
      const at = turns.findLastIndex((turn) => turn.role === "user");
      const done = turns.slice(at).filter((turn) => turn.role === "toolResult").length;
      if (!(turns[at]?.text ?? "").includes("LONG-TURN")) return { text: "noted" };
      return done === 0
        ? { tool: "bash", args: { command: hold("ops") } }
        : { text: "long turn finished" };
    }, "mate");
  }
}

interface Before {
  readonly pid: number;
  readonly file: string;
  readonly until: number | null;
}

async function before(worker: Worker): Promise<Before> {
  const pid = await until(() => fleet.piIn(worker.pane), `${worker.session} to run Pi`);
  const cwd = realpathSync(worker.worktree);
  const event = await until(() => fleet.sessionEvents(cwd)[0], `${worker.session}'s session`);
  const card = await fleet.cardOf(worker.card);
  return { pid, file: String(event["file"]), until: card.until };
}

async function onNewCode(worker: Worker, was: Before): Promise<void> {
  const pid = await fleet.newPid(worker.pane, was.pid);
  assert.notEqual(pid, was.pid);
  const cwd = realpathSync(worker.worktree);
  const events = await until(
    () => (fleet.sessionEvents(cwd).length >= 2 ? fleet.sessionEvents(cwd) : undefined),
    `${worker.session}'s new session`,
  );
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => [event["file"], event["reason"]]),
    [
      [was.file, "startup"],
      [was.file, "startup"],
    ],
  );
  assert.equal(git(worker.worktree, "branch", "--show-current"), worker.branch);
  const card = await fleet.cardOf(worker.card);
  assert.equal(card.status, "paused");
  assert.notEqual(card.until, null);
  if (was.until !== null) assert.equal(card.until, was.until);
}

async function asksWithNewCode(worker: Worker): Promise<void> {
  const title = worker.session;
  await fleet.ghost.call("comment", { card: worker.card, text: `CHECK-NEW-CODE ${title}` });
  const turns = await until(
    () =>
      fleet.h.callsOf("worker").find((each) => lastUser(each).includes(`CHECK-NEW-CODE ${title}`)),
    `${title} to answer on the new code`,
  );
  assert.match(systemOf(turns), RegExp(NEW_CODE));
  assert.ok(turns.some((turn) => turn.role === "user" && turn.text.includes("START-")));
  const first = fleet.h
    .callsOf("worker")
    .find((each) => each.some((turn) => turn.text.includes(`c-${String(worker.card)} `)));
  assert.doesNotMatch(systemOf(first ?? []), RegExp(NEW_CODE));
}

async function mainHears(
  workers: readonly Worker[],
  expected = "5 reloaded and verified, 1 failed",
  prompt = "WHO-RELOADED",
): Promise<void> {
  await fleet.matePid("main");
  await fleet.lab.submit(fleet.mainPane, prompt);
  const heard = await until(
    () => fleet.h.callsOf("mate").find((each) => lastUser(each).includes(prompt)),
    "main to answer",
  );
  const told = heard
    .filter((turn) => turn.text.startsWith("[fleet] maintenance:"))
    .map((turn) => turn.text);
  const summaries = told.filter((line) => line.includes("Reload batch "));
  assert.equal(summaries.length, 1, told.join("\n"));
  assert.ok(summaries[0]?.includes(expected));
  assert.equal(told.filter((line) => line.includes("reload completed -")).length, 0);
  for (const worker of workers) {
    const history = await fleet.ghost.call("card", { card: worker.card });
    assert.ok(
      check(OPS.card.result, history).entries.some((entry) =>
        entry.body.includes(
          `${worker.session} (worker on ${worker.host}): reload completed - ${NOW_LINE}`,
        ),
      ),
    );
  }
}

test("update_fleet reloads every worker and second mate at its safe point, never during a turn or a job, and each returns on its own conversation, branch and worktree with the new code and its pause kept", async () => {
  script();
  await fleet.startMain();
  const mates = { ops: await fleet.matePid("ops"), far: await fleet.matePid("far") };
  const busy = await fleet.startWorker("busy", "local");
  const job = await fleet.startWorker("job", "local");
  const paused = await fleet.startWorker("paused", "p620");
  await until(
    () => (reached("busy", "started") && reached("job", "started") ? true : undefined),
    "the busy turn and the job to start",
  );
  await until(
    async () => ((await fleet.cardOf(paused.card)).status === "paused" ? true : undefined),
    "the far worker to pause",
  );
  const opsPane = await until(() => fleet.paneOf("2ndmate-ops"), "ops's pane");
  await fleet.lab.submit(opsPane, "LONG-TURN please");
  await until(() => (reached("ops", "started") ? true : undefined), "ops's long turn to start");
  const was = { busy: await before(busy), job: await before(job), paused: await before(paused) };
  const modelCallsOfPaused = fleet
    .userTexts("worker")
    .filter((text) => text.includes("START-paused")).length;
  const old = git(fleet.here.root, "rev-parse", "HEAD");
  fleet.landCode();

  await fleet.lab.submit(fleet.mainPane, "/updatefleet");
  const report = await until(
    () => fleet.userTexts("mate").find((text) => text.startsWith("[fleet] update:")),
    "main to record the update's report",
  );
  const section = report
    .slice(report.indexOf("Reloads at each"), report.indexOf("Sidebars:"))
    .trimEnd();
  assert.equal(
    section,
    [
      "Reloads at each safe point (pending is not completed):",
      "Reloaded and verified:",
      `- ${paused.session} (worker on p620): reload completed - ${NOW_LINE}`,
      `- far (mate): reload completed - ${NOW_LINE}`,
      "Waiting for a safe point, not yet reloaded (main hears one summary when the batch finishes):",
      `- ${busy.session} (worker on local): reload pending - ${SAFE_POINT}`,
      `- ${job.session} (worker on local): reload pending - ${SAFE_POINT}`,
      `- ops (mate): reload pending - ${SAFE_POINT}`,
      "Unable to reload:",
      "- ghost (mate): reload failed - runs code from before safe reloads, so it was left running: restart it by hand",
    ].join("\n"),
  );
  assert.notEqual(git(fleet.here.root, "rev-parse", "HEAD"), old);

  assert.equal(await fleet.piIn(busy.pane), was.busy.pid);
  assert.equal(await fleet.piIn(job.pane), was.job.pid);
  assert.equal(await fleet.piIn((await fleet.paneOf("2ndmate-ops")) ?? ""), mates.ops);
  assert.equal(reached("busy", "finished") || reached("ops", "finished"), false);
  assert.equal(readFileSync(fleet.gate("job-runs"), "utf8"), "run\n");
  assert.equal(reached("job", "finished"), false);
  await onNewCode(paused, was.paused);
  assert.equal(
    fleet.userTexts("worker").filter((text) => text.includes("START-paused")).length,
    modelCallsOfPaused,
  );

  fleet.open("busy-gate");
  await onNewCode(busy, was.busy);
  fleet.open("ops-gate");
  assert.notEqual(
    await fleet.newPid((await fleet.paneOf("2ndmate-ops")) ?? "", mates.ops),
    mates.ops,
  );
  fleet.open("job-gate");
  await onNewCode(job, was.job);
  assert.equal(readFileSync(fleet.gate("job-runs"), "utf8"), "run\n");

  for (const worker of [busy, job, paused]) await asksWithNewCode(worker);
  await fleet.lab.submit(
    await until(() => fleet.paneOf("2ndmate-ops"), "ops's pane"),
    "AFTER-RELOAD",
  );
  const afterOps = await until(
    () => fleet.h.callsOf("mate").find((each) => lastUser(each).includes("AFTER-RELOAD")),
    "ops to answer on the new code",
  );
  assert.match(systemOf(afterOps), RegExp(NEW_CODE));
  assert.ok(afterOps.some((turn) => turn.role === "user" && turn.text.includes("LONG-TURN")));

  await mainHears([busy, job, paused]);
});

test("a successful multi-host update summarizes real replacements once, including a late safe point and duplicate receipts", async () => {
  script();
  const control = await fleet.cardd.connect(fleet.mainToken);
  await control.call("lane.stopping", { lane: "ghost" });
  await control.close();
  await fleet.startMain();
  const mates = { ops: await fleet.matePid("ops"), far: await fleet.matePid("far") };
  const busy = await fleet.startWorker("busy", "local");
  const paused = await fleet.startWorker("paused", "p620");
  await until(() => (reached("busy", "started") ? true : undefined), "busy's turn");
  await until(
    async () => ((await fleet.cardOf(paused.card)).status === "paused" ? true : undefined),
    "the far worker to pause",
  );
  const was = { busy: await before(busy), paused: await before(paused) };
  fleet.landCode();
  await fleet.lab.submit(fleet.mainPane, "/updatefleet");
  const report = await until(
    () => fleet.userTexts("mate").find((text) => text.startsWith("[fleet] update:")),
    "the update report before the late safe point",
  );
  assert.ok(report.includes(`${busy.session} (worker on local): reload pending`));
  assert.equal(await fleet.piIn(busy.pane), was.busy.pid);
  await onNewCode(paused, was.paused);
  for (const lane of ["ops", "far"] as const) {
    const pane = await until(() => fleet.paneOf(`2ndmate-${lane}`), `${lane}'s pane`);
    assert.notEqual(await fleet.newPid(pane, mates[lane]), mates[lane]);
  }
  fleet.open("busy-gate");
  await onNewCode(busy, was.busy);
  for (const worker of [busy, paused]) await asksWithNewCode(worker);
  await mainHears([busy, paused], "4 reloaded and verified, 0 failed");
  const history = check(OPS.card.result, await fleet.ghost.call("card", { card: busy.card }));
  const receipt = history.entries.find((entry) => typeof entry.fields["maintenance"] === "number");
  assert.ok(receipt);
  const id = receipt.fields["maintenance"];
  assert.equal(typeof id, "number");
  const owner = await fleet.cardd.connect(busy.token, [], true, false, true, true);
  try {
    const duplicate = check(
      OPS["maintenance.ack"].result,
      await owner.call("maintenance.ack", {
        id,
        state: "failed",
        detail: "late duplicate helper failure",
      }),
    );
    assert.equal(duplicate.state, "completed");
    assert.equal(duplicate.detail, NOW_LINE);
  } finally {
    await owner.close();
  }
  await mainHears([busy, paused], "4 reloaded and verified, 0 failed", "AFTER-DUPLICATE");
  const after = check(OPS.card.result, await fleet.ghost.call("card", { card: busy.card }));
  assert.equal(after.entries.filter((entry) => entry.fields["maintenance"] === id).length, 1);
});
