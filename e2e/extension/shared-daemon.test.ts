import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { parseRecord } from "../support/json.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("../support/fake-no-mistakes.ts", import.meta.url));

const dispatchStep = {
  title: "Gate the change",
  name: "gate-change",
  kind: "ship",
  project: "site",
  intent: "Fix the scrollbar",
  host: "local",
  task: "validate the change",
};

let parts: DispatchLab;
let h: Harness;
let clone: string;
let mate: Pi;
let shared: string;
beforeEach(async () => {
  parts = await startDispatchLab({ workerArgs: ["-e", SHELL] });
  ({ h, clone, mate } = parts);
  parts.cardd.yolo("site");
  shared = join(h.dir, "nm");
});
afterEach(async () => {
  try {
    const { sharedOut, privateOut, lookalike } = neighbours();
    const recorded = [daemonIn(sharedOut), daemonIn(privateOut), pidIn(lookalike)];
    const own = treeOf(join(`${clone}.worktrees`, "c-1-a1", ".nm"));
    const starting = daemonIn(sharedOut);
    if (starting !== undefined) {
      try {
        process.kill(starting, "SIGTERM");
      } catch {
        void 0;
      }
    }
    for (const pid of [
      ...treeOf(shared),
      ...own,
      ...recorded.filter((each) => each !== undefined),
    ]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        void 0;
      }
    }
  } finally {
    await stopDispatchLab(parts);
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function treeOf(root: string): number[] {
  const file = join(root, "tree.json");
  if (!existsSync(file)) return [];
  return Object.values(parseRecord(readFileSync(file, "utf8"))).map(Number);
}

const servedBy = (root: string): string =>
  execFileSync("node", [FAKE, "health", root], { encoding: "utf8" }).trim();

const written = (file: string): string | undefined =>
  existsSync(file) && readFileSync(file, "utf8").trim() !== ""
    ? readFileSync(file, "utf8").trim()
    : undefined;

const pidIn = (file: string): number | undefined => {
  const text = written(file);
  return text === undefined ? undefined : Number(text);
};

const daemonIn = (file: string): number | undefined => {
  const text = written(file);
  return text === undefined ? undefined : Number(parseRecord(text)["daemon"]);
};

const waitFor = (file: string): string =>
  `i=0; while [ ! -s '${file}' ]; do i=$((i+1)); [ $i -gt 100 ] && { echo "${file} was never written"; exit 1; }; sleep 0.1; done`;

const gateDaemon = (root: string, out: string, env = ""): string =>
  `${env}FAKE_NM_ROOT=${root} node '${FAKE}' axi run > '${out}'`;

function neighbours(): { sharedOut: string; privateOut: string; lookalike: string } {
  return {
    sharedOut: join(h.dir, "shared.out"),
    privateOut: join(h.dir, "private.out"),
    lookalike: join(h.dir, "lookalike.pid"),
  };
}

function workerCommand(): string {
  const { sharedOut, privateOut, lookalike } = neighbours();
  return [
    `echo .nm >> "$(git rev-parse --git-path info/exclude)"`,
    gateDaemon(`'${shared}'`, sharedOut),
    gateDaemon('"$PWD/.nm"', privateOut),
    `node '${FAKE}' lookalike '${shared}' '${lookalike}' >/dev/null`,
    waitFor(lookalike),
  ].join("\n");
}

function started(): { daemon: number; lookalike: number; own: number } {
  const { sharedOut, privateOut, lookalike } = neighbours();
  const found = {
    daemon: daemonIn(sharedOut),
    own: daemonIn(privateOut),
    lookalike: pidIn(lookalike),
  };
  const { daemon, own, lookalike: fake } = found;
  assert.ok(
    daemon !== undefined && own !== undefined && fake !== undefined,
    "the worker did not start its processes",
  );
  return { daemon, own, lookalike: fake };
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function assertSharedDaemonKept(daemon: number): void {
  const tree = parseRecord(readFileSync(join(shared, "tree.json"), "utf8"));
  assert.equal(servedBy(shared), String(daemon), "the shared daemon no longer answers");
  assert.equal(alive(Number(tree["sink"])), true, "the daemon's log sink was stopped");
  assert.equal(
    alive(Number(tree["step"])),
    true,
    "a process the daemon runs for a pipeline was stopped",
  );
}

test("close keeps the shared daemon that a worker started, and still stops what else it left", async () => {
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command: workerCommand() } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "gate running" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("gate the change");
  const result = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  const { daemon, lookalike, own } = started();

  assert.match(result, /^c-1 is done\./);
  assertSharedDaemonKept(daemon);
  assert.match(result, new RegExp(`Kept shared services: c-1-a1 pid ${String(daemon)} \\(`));
  assert.equal(alive(lookalike), false, "a process that only looks like the daemon survived");
  assert.equal(alive(own), false, "a daemon whose root lives in the worktree survived");
  assert.match(result, new RegExp(`Stopped leftover processes: .*pid ${String(lookalike)} `));
  assert.match(result, new RegExp(`Stopped leftover processes: .*pid ${String(own)} `));
  assert.doesNotMatch(
    result,
    new RegExp(`pid ${String(daemon)} \\([^)]*\\) (stopped|needed|still)`),
  );
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
});

test("close keeps the shared daemon that a job of the worker started from the worktree", async () => {
  const { sharedOut } = neighbours();
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({
      tool: "run_long",
      args: { label: "gate", command: gateDaemon(`'${shared}'`, sharedOut) },
    }),
    "worker",
  );
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "gate running" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("gate the change");
  const result = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  const daemon = daemonIn(sharedOut);
  assert.ok(daemon !== undefined, "the job did not start a daemon");

  assert.match(result, /^c-1 is done\./);
  assertSharedDaemonKept(daemon);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
});

test("restarting a worker keeps the shared daemon it started, and still stops what else it left", async () => {
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "restart_card", args: { card: 1, key: "again" } }), "mate");
  h.onModel(() => ({ text: "restarted" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command: workerCommand() } }), "worker");
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  h.onModel(() => ({ text: "started again" }), "worker");
  await connected(h);
  mate.prompt("gate the change");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  await eventually(
    () => written(neighbours().lookalike) !== undefined,
    "the worker to start its processes",
  );
  const { daemon, lookalike, own } = started();
  mate.prompt("restart it");
  await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  await eventually(() => !alive(lookalike) && !alive(own), "the old worker's processes to stop");

  assertSharedDaemonKept(daemon);
});

test("close keeps a shared daemon that has not published its pid file yet", async () => {
  const { sharedOut } = neighbours();
  const publish = join(h.dir, "publish");
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({
      tool: "bash",
      args: {
        command: [
          `echo .nm >> "$(git rev-parse --git-path info/exclude)"`,
          gateDaemon(`'${shared}'`, sharedOut, `FAKE_NM_PUBLISH_AFTER='${publish}' `),
        ].join("\n"),
      },
    }),
    "worker",
  );
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "gate starting" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("gate the change");
  const result = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  const daemon = daemonIn(sharedOut);
  assert.ok(daemon !== undefined, "the worker did not start a daemon");

  assert.match(result, /^c-1 is done\./);
  assert.equal(existsSync(join(shared, "daemon.pid")), false, "the daemon had published already");
  assert.equal(servedBy(shared), String(daemon), "the starting daemon was stopped");
  assert.match(result, new RegExp(`Kept shared services: c-1-a1 pid ${String(daemon)} `));
  writeFileSync(publish, "");
  await eventually(() => existsSync(join(shared, "tree.json")), "the daemon to publish");
  assertSharedDaemonKept(daemon);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
});
