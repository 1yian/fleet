import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { Harness, Pi } from "../support/harness.ts";
import { until } from "../support/live-fleet.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

let parts: DispatchLab;
let h: Harness;
let clone: string;
let mate: Pi;
beforeEach(async () => {
  parts = await startDispatchLab({ workerArgs: ["-e", SHELL] });
  ({ h, clone, mate } = parts);
  parts.cardd.yolo("site");
});
afterEach(async () => {
  await stopDispatchLab(parts);
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const LAUNCHER = `
const { spawn } = require("node:child_process");
const [cwd, script, ...rest] = process.argv.slice(2);
spawn("sh", ["-c", script, "sh", ...rest], { cwd, detached: true, stdio: "ignore" }).unref();
`;

async function closeWithLeftover(
  body: string,
  options: {
    arg?: string;
    cwd?: string;
    outside?: boolean;
    twice?: boolean;
    merged?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ pid: number; result: string; results: string[] }> {
  const pidFile = join(h.dir, "leftover.pid");
  const launcher = join(h.dir, "launch.cjs");
  writeFileSync(launcher, LAUNCHER);
  const script = `echo $$ > "${pidFile}"; ${body}`;
  const extra = options.arg === undefined ? "" : ` '${options.arg}'`;
  const cwd = options.cwd === undefined ? '"$PWD"' : `'${options.cwd}'`;
  const marks = Object.entries(options.env ?? {}).map(([name, value]) => `${name}=${value} `);
  const launch = `${marks.join("")}node "${launcher}" ${cwd} '${script}'${extra}`;
  if (options.outside === true) execSync(launch, { cwd: h.dir });
  const start = `${options.outside === true ? "" : launch}\ni=0; while [ ! -s "${pidFile}" ]; do i=$((i+1)); [ $i -gt 100 ] && { echo "leftover did not start"; exit 1; }; sleep 0.1; done`;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Run a dev stack",
        name: "dev-stack",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "local",
        task: "start the stack",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command: start } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "stack running" } }), "worker");
  const { merged } = options;
  if (merged !== undefined) {
    parts.cardd.gh.setPr(merged, "MERGED");
    h.onModel(
      () => ({
        tool: "report",
        args: { status: "merged", text: "landed", pr: merged },
      }),
      "worker",
    );
    h.onModel(() => ({ text: "reported" }), "worker");
  }
  const close = { tool: "close", args: { card: 1, summary: "Done." } };
  h.onModel(() => (options.twice === true ? { ...close, alongside: [close] } : close), "mate");
  if (merged !== undefined) h.onModel(() => ({ text: "relayed" }), "mate");
  await connected(h);
  mate.prompt("run the stack");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return { pid, result: results.at(-1) ?? "", results };
}

test("close stops a detached process that was left in the worktree and names it", async () => {
  const { pid, result } = await closeWithLeftover("exec sleep 1000");
  assert.equal(alive(pid), false);
  assert.match(
    result,
    new RegExp(
      `^c-1 is done\\. Stopped leftover processes: c-1-a1 pid ${String(pid)} \\(.*sleep 1000.*\\) stopped by TERM\\.`,
    ),
  );
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.equal(existsSync(`${clone}.worktrees/c-1-a1`), false);
});

test("close kills a leftover process that ignores TERM", async () => {
  const { pid, result } = await closeWithLeftover('trap "" TERM; while :; do sleep 1; done');
  assert.equal(alive(pid), false);
  assert.match(result, new RegExp(`pid ${String(pid)} \\(.*\\) needed KILL`));
});

test("close says nothing about processes when none were left", async () => {
  const { result } = await closeWithLeftover("exit 0");
  assert.equal(result, "c-1 is done.");
});

interface Outsider {
  arg?: string;
  cwd?: string;
  env?: Record<string, string>;
}

const killQuietly = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    void 0;
  }
};

const survives = async (outsider: (worktree: string) => Outsider): Promise<void> => {
  const worktree = `${clone}.worktrees/c-1-a1`;
  const { pid, result } = await closeWithLeftover("while :; do sleep 1; done", {
    cwd: h.dir,
    ...outsider(worktree),
    outside: true,
  });
  try {
    assert.equal(result, "c-1 is done.");
    assert.equal(alive(pid), true);
  } finally {
    killQuietly(pid);
  }
};

test("close leaves a process that names a sibling directory of the worktree", async () => {
  await survives((worktree) => ({ arg: `${worktree}+cache/server.js` }));
});

test("close leaves a process that names the worktree path under another prefix", async () => {
  await survives((worktree) => ({ arg: `/backup${worktree}/server.js` }));
});

test("close stops a process outside the worktree that names a path inside it", async () => {
  const { pid, result } = await closeWithLeftover("while :; do sleep 1; done", {
    arg: `${clone}.worktrees/c-1-a1/server.js`,
    cwd: h.dir,
    outside: true,
  });
  try {
    assert.match(result, new RegExp(`pid ${String(pid)} \\(.*\\) stopped by TERM`));
    assert.equal(alive(pid), false);
  } finally {
    killQuietly(pid);
  }
});

test("close leaves a process that fleet started and that names a path inside the worktree", async () => {
  await survives((worktree) => ({
    arg: `${worktree}/server.js`,
    env: { FLEET_HELPER: "1" },
  }));
});

const KEEP_RUNNING = 'exec node -e "setInterval(Function(), 1000)" "$1"';
const HELPER_LOOKALIKE = "# Finds the host-shared services that a worker started";

test("close still stops a leftover whose command line reads like one of fleet's own helpers", async () => {
  const { pid, result } = await closeWithLeftover(KEEP_RUNNING, { arg: HELPER_LOOKALIKE });
  assert.equal(alive(pid), false);
  assert.match(
    result,
    new RegExp(` pid ${String(pid)} \\(.*Finds the host-shared.*\\) stopped by TERM`),
  );
});

const stoppedPids = (text: string): string[] =>
  [
    ...(
      /Stopped leftover processes: ([^]*?)\.(?: Kept| Unlanded| Left| Clones|$)/.exec(text)?.[1] ??
      ""
    ).matchAll(/ pid (\d+) /g),
  ].map((each) => each[1] ?? "");

const STUBBORN =
  'exec node -e "process.on(process.argv[1], Function()); setInterval(Function(), 1000)" SIGTERM';

test("two closes of one card at once close it once and stop only the leftover process", async () => {
  const { pid, results } = await closeWithLeftover(STUBBORN, { twice: true });
  const closes = results.slice(-2);
  assert.equal(closes.length, 2);
  for (const each of closes) {
    assert.match(each, /^c-1 is done\./);
    assert.deepEqual(stoppedPids(each), [String(pid)]);
    assert.doesNotMatch(each, /Finds the host-shared|killed by/);
  }
  assert.equal(alive(pid), false);
  const closed = (await parts.cardd.thread(1)).entries.filter((each) => each.kind === "cleanup");
  assert.equal(closed.length, 1);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.equal(existsSync(`${clone}.worktrees/c-1-a1`), false);
});

test("a close that another close of the card beats says so instead of failing", async () => {
  const termed = join(h.dir, "termed");
  const elsewhere = until(
    () => (existsSync(termed) ? true : undefined),
    "the leftover to be told to stop",
  ).then(() =>
    parts.cardd.post(parts.mainToken, "close.finish", {
      card: 1,
      mode: "done",
      text: "Closed from another session.",
      archives: [],
      left: [],
    }),
  );
  const { pid, result } = await closeWithLeftover(
    `trap "touch ${termed}" TERM; while :; do sleep 1; done`,
  );
  assert.equal((await elsewhere).status, 200);
  assert.equal(
    result,
    "c-1 was closed by another close at the same time, so there is nothing left to do.",
  );
  assert.equal(alive(pid), false);
  const closed = (await parts.cardd.thread(1)).entries.filter((each) => each.kind === "cleanup");
  assert.equal(closed.length, 1);
});

test("a merged report that closes a card on its own while the mate closes it stops only the leftover", async () => {
  const pr = "https://github.com/acme/site/pull/381";
  const { pid, results } = await closeWithLeftover(STUBBORN, { merged: pr });
  const delivered = await until(
    () =>
      h
        .callsOf("mate")
        .flat()
        .find((turn) => turn.role === "user" && turn.text.includes("merged: landed")),
    "the merged report to reach the mate",
  );
  const outcomes = [results.at(-1) ?? "", delivered.text];
  for (const each of outcomes) assert.doesNotMatch(each, /Finds the host-shared|killed by/);
  assert.match(outcomes[0] ?? "", /^c-1 is done\./);
  assert.deepEqual(stoppedPids(outcomes[0] ?? ""), [String(pid)]);
  assert.match(outcomes[1] ?? "", /Closed automatically: c-1 is done|c-1 is already done/);
  assert.equal(alive(pid), false);
  const closed = (await parts.cardd.thread(1)).entries.filter((each) => each.kind === "cleanup");
  assert.equal(closed.length, 1);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.equal(existsSync(`${clone}.worktrees/c-1-a1`), false);
});
