import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  worktreesOf,
} from "../support/dispatch-lab.ts";
import { until } from "../support/live-fleet.ts";
import { tempDir } from "../support/run-root.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killQuietly = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    void 0;
  }
};

function slowPs(): { bin: string; slow: string; started: () => number[] } {
  const bin = tempDir("fleet-slow-ps-");
  const slow = join(bin, "slow");
  const started = join(bin, "started");
  const real = execFileSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).trim();
  const shim = [
    "#!/bin/sh",
    `if [ -e '${slow}' ]; then echo $$ >> '${started}'; exec sleep 3600; fi`,
    `exec '${real}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(bin, "ps"), shim);
  chmodSync(join(bin, "ps"), 0o755);
  return {
    bin,
    slow,
    started: () =>
      existsSync(started)
        ? readFileSync(started, "utf8").split("\n").filter(Boolean).map(Number)
        : [],
  };
}

const SCAN_CAP_MS = 90_000;
const STALL_WAIT_MS = SCAN_CAP_MS + WORKER_WAIT_MS;

async function closeOnLoadedHost(
  limits: Record<string, string>,
  why: string,
  retry: boolean,
): Promise<void> {
  const ps = slowPs();
  const parts = await startDispatchLab({
    workerArgs: ["-e", SHELL],
    mate: { PATH: `${ps.bin}:${process.env["PATH"] ?? ""}`, ...limits },
  });
  const { h, clone, mate } = parts;
  try {
    parts.cardd.yolo("site");
    h.onModel(() => ({ tool: "board", args: {} }), "mate");
    h.onModel(
      () => ({
        tool: "dispatch",
        args: {
          title: "Fix the scrollbar",
          name: "scrollbar",
          kind: "ship",
          project: "site",
          intent: "Fix the scrollbar",
          host: "local",
          task: "fix it",
        },
      }),
      "mate",
    );
    h.onModel(() => ({ text: "dispatched" }), "mate");
    h.onModel(() => ({ tool: "bash", args: { command: `touch '${ps.slow}'` } }), "worker");
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "finished" } }), "worker");
    h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
    h.onModel(() => ({ text: "stalled" }), "mate");
    h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
    h.onModel(() => ({ text: "closed" }), "mate");
    await mateConnected(h);
    mate.prompt("fix the scrollbar");

    const stalled = toolResults(await h.waitForCall(4, "mate", STALL_WAIT_MS)).at(-1) ?? "";
    assert.equal(
      stalled,
      `c-1 was not closed. Step "stop the worker's processes" for c-1-a1 on local ${why}, so close stopped there. Not done: stop the worker's processes, archive unlanded work, remove the worktree, delete the task branch, record the close. c-1 stays open: close it again when local answers.`,
    );
    assert.equal(existsSync(`${clone}.worktrees/c-1-a1`), true);
    assert.equal(worktreesOf(clone).length, 2);
    const entries = (await parts.cardd.thread(1)).entries;
    assert.equal(entries.filter((each) => each.kind === "cleanup").length, 0);
    const scans = ps.started();
    assert.notEqual(scans.length, 0);
    for (const pid of scans) {
      await until(
        () => (alive(pid) ? undefined : true),
        `the slow ps ${String(pid)} to be stopped`,
      );
    }

    if (!retry) return;
    rmSync(ps.slow);
    mate.prompt("close it again");
    const closed = toolResults(await h.waitForCall(6, "mate", STALL_WAIT_MS)).at(-1) ?? "";
    assert.equal(closed, "c-1 is done.");
    assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
    assert.equal(existsSync(`${clone}.worktrees/c-1-a1`), false);
  } finally {
    for (const pid of ps.started()) killQuietly(pid);
    await stopDispatchLab(parts);
  }
}

test("close on a host where ps stalls stops at the scan limit, leaves the card open, and closes on the next call", async () => {
  await closeOnLoadedHost(
    { FLEET_SCAN_TIMEOUT_MS: String(SCAN_CAP_MS) },
    `did not finish within ${String(SCAN_CAP_MS / 1000)} s`,
    true,
  );
});

test("close that runs past its overall limit stops at the step in flight and leaves the card open", async () => {
  await closeOnLoadedHost(
    { FLEET_CLOSE_DEADLINE_MS: "15000" },
    "ran past close's overall limit of 15 s",
    false,
  );
});
