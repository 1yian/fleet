import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  branchesOf,
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

function stallingTool(
  tool: string,
  stall: (slow: string) => string,
): { bin: string; slow: string; started: () => number[] } {
  const bin = tempDir(`fleet-slow-${tool}-`);
  const slow = join(bin, "slow");
  const started = join(bin, "started");
  const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
  const shim = [
    "#!/bin/sh",
    `if [ -e '${slow}' ]; then echo $$ >> '${started}'; ${stall(slow)}; fi`,
    `exec '${real}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(bin, tool), shim);
  chmodSync(join(bin, tool), 0o755);
  return {
    bin,
    slow,
    started: () =>
      existsSync(started)
        ? readFileSync(started, "utf8").split("\n").filter(Boolean).map(Number)
        : [],
  };
}

const slowPs = () => stallingTool("ps", () => "exec sleep 3600");

const slowZstd = () => stallingTool("zstd", (slow) => `while [ -e '${slow}' ]; do sleep 0.1; done`);

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
    { FLEET_CLOSE_DEADLINE_MS: "8000" },
    "ran past close's overall limit of 8 s",
    false,
  );
});

const ARCHIVE_DEADLINE_MS = 45_000;

const inArchive = (archive: string, member: string): string =>
  execFileSync("sh", ["-c", `zstd -dc '${archive}' | tar -xOf - '${member}'`], {
    encoding: "buffer",
  }).toString("latin1");

test("close whose deadline passes during the archive lets it finish, then refuses to start the removal", async () => {
  const zstd = slowZstd();
  const parts = await startDispatchLab({
    workerArgs: ["-e", SHELL],
    mate: {
      PATH: `${zstd.bin}:${process.env["PATH"] ?? ""}`,
      FLEET_CLOSE_DEADLINE_MS: String(ARCHIVE_DEADLINE_MS),
    },
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
    h.onModel(
      () => ({
        tool: "bash",
        args: {
          command: `echo unlanded > unlanded.txt && git -c user.name=w -c user.email=w@example.com commit -q --allow-empty -m unlanded-commit && touch '${zstd.slow}'`,
        },
      }),
      "worker",
    );
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "finished" } }), "worker");
    h.onModel(
      () => ({ tool: "close", args: { card: 1, summary: "Done.", confirm: true } }),
      "mate",
    );
    h.onModel(() => ({ text: "stalled" }), "mate");
    h.onModel(
      () => ({ tool: "close", args: { card: 1, summary: "Done.", confirm: true } }),
      "mate",
    );
    h.onModel(() => ({ text: "closed" }), "mate");
    await mateConnected(h);
    mate.prompt("fix the scrollbar");

    const worktree = `${clone}.worktrees/c-1-a1`;
    const archiveDir = `${clone}.archive`;
    const archive = join(archiveDir, "c-1-a1.tar.zst");
    const [archiving = 0] = await until(
      () => (zstd.started().length > 0 ? zstd.started() : undefined),
      "the archive to start",
    );
    assert.equal(alive(archiving), true);
    assert.equal(existsSync(archive), false);
    const archivingSince = Date.now();
    await until(
      () => (Date.now() > archivingSince + ARCHIVE_DEADLINE_MS ? true : undefined),
      "the close deadline to pass during the archive",
    );
    assert.equal(alive(archiving), true);
    rmSync(zstd.slow);

    const refused = toolResults(await h.waitForCall(4, "mate", STALL_WAIT_MS)).at(-1) ?? "";
    assert.equal(
      refused,
      `c-1 was not closed. Step "remove the worktree" for c-1-a1 on local did not start because close ran past its overall limit of ${String(ARCHIVE_DEADLINE_MS / 1000)} s, so close stopped there. Not done: remove the worktree, delete the task branch, record the close. c-1 stays open: close it again when local answers.`,
    );
    assert.equal(existsSync(worktree), true);
    assert.equal(branchesOf(clone).length, 2);
    assert.deepEqual(readdirSync(archiveDir), ["c-1-a1.tar.zst"]);
    execFileSync("zstd", ["-t", "-q", archive]);
    const entries = (await parts.cardd.thread(1)).entries;
    assert.equal(entries.filter((each) => each.kind === "cleanup").length, 0);
    const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    mate.prompt("close it again");
    const closed = toolResults(await h.waitForCall(6, "mate", STALL_WAIT_MS)).at(-1) ?? "";
    assert.equal(closed, `c-1 is done. Unlanded work is archived in local:${archive}.`);
    assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
    assert.deepEqual(branchesOf(clone), ["main"]);
    assert.equal(existsSync(worktree), false);
    assert.deepEqual(readdirSync(archiveDir), ["c-1-a1.tar.zst"]);
    execFileSync("zstd", ["-t", "-q", archive]);
    assert.match(inArchive(archive, "c-1-a1/commits.bundle"), /^# v\d/);
    assert.match(inArchive(archive, "c-1-a1/manifest.json"), new RegExp(`"head":"${head}"`));
    assert.match(inArchive(archive, "c-1-a1/untracked.tar"), /unlanded\.txt/);
  } finally {
    for (const pid of zstd.started()) killQuietly(pid);
    await stopDispatchLab(parts);
  }
});
