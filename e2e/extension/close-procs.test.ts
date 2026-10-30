import assert from "node:assert/strict";
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
const [cwd, script, ...rest] = process.argv.slice(1);
spawn("sh", ["-c", script, "sh", ...rest], { cwd, detached: true, stdio: "ignore" }).unref();
`;

async function closeWithLeftover(
  body: string,
  options: { arg?: string; cwd?: string } = {},
): Promise<{ pid: number; result: string }> {
  const pidFile = join(h.dir, "leftover.pid");
  const launcher = join(h.dir, "launch.cjs");
  writeFileSync(launcher, LAUNCHER);
  const script = `echo $$ > "${pidFile}"; ${body}`;
  const extra = options.arg === undefined ? "" : ` '${options.arg}'`;
  const cwd = options.cwd === undefined ? '"$PWD"' : `'${options.cwd}'`;
  const start = `node "${launcher}" ${cwd} '${script}'${extra}\ni=0; while [ ! -s "${pidFile}" ]; do i=$((i+1)); [ $i -gt 100 ] && { echo "leftover did not start"; exit 1; }; sleep 0.1; done`;
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
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("run the stack");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return { pid, result: results.at(-1) ?? "" };
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

const survives = async (arg: (worktree: string) => string): Promise<void> => {
  const { pid, result } = await closeWithLeftover("while :; do sleep 1; done", {
    arg: arg(`${clone}.worktrees/c-1-a1`),
    cwd: h.dir,
  });
  try {
    assert.equal(result, "c-1 is done.");
    assert.equal(alive(pid), true);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
};

test("close leaves a process that names a sibling directory of the worktree", async () => {
  await survives((worktree) => `${worktree}+cache/server.js`);
});

test("close leaves a process that names the worktree path under another prefix", async () => {
  await survives((worktree) => `/backup${worktree}/server.js`);
});
