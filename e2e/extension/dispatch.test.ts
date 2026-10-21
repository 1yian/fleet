// dispatch through herdr (spec sections 11.2 and 25, test 8). A real mate Pi
// with the fleet extension dispatches a real worker Pi into a herdr lab
// session, in its own git worktree. Both use the scripted fake model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  branchesOf,
  lastUser,
  launchArgsOf,
  mateConnected as connected,
  sidebarOf,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerGroupOf,
  workersOf,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { Harness, Pi } from "../support/harness.ts";
import type { HerdrLab } from "../support/herdr.ts";

const PR = "https://github.com/acme/web/pull/1";

/**
 * herdr can still hold a dead worker's agent name for a few seconds, up to 4 s on CI, and refuses to
 * start a Pi under it until then. A refused start used to wait 10 s for a Pi that herdr never typed. So
 * the restart must hold the mate for less than that wait alone, however slow the rest is under load.
 */
const RESTART_WAIT_MS = 10_000;

let parts: DispatchLab;
let h: Harness;
let lab: HerdrLab;
let clone: string;
let mate: Pi;
let home: string;
beforeEach(async () => {
  parts = await startDispatchLab();
  ({ h, lab, clone, mate, home } = parts);
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const launchArgs = (): string => launchArgsOf(h);
const worktrees = (): string[] => worktreesOf(clone);
const branches = (): string[] => branchesOf(clone);
const sidebar = (): Promise<string[]> => sidebarOf(lab);
const workers = (): Promise<string[]> => workersOf(lab);
const mateConnected = () => connected(h);

function scriptMate(...dispatches: { host: string }[]): void {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  for (const { host } of dispatches) {
    h.onModel(
      () => ({ tool: "dispatch", args: { card: 1, host, task: "fix the scrollbar" } }),
      "mate",
    );
  }
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "report", args: { status: "done", text: "PR green", pr: PR } }),
    "worker",
  );
}

test("dispatch starts a worker in its own worktree, and the worker's report reaches the mate", async () => {
  scriptMate({ host: "local" });
  for (const label of ["fleet-main", "fleet-cleo"]) {
    await lab.run(["workspace", "create", "--cwd", home, "--label", label, "--no-focus"]);
  }
  await mateConnected();
  mate.prompt("ship the scrollbar fix");
  const woken = await h.waitForCall(3, "mate", WORKER_WAIT_MS);

  assert.deepEqual(
    toolResults(await h.waitForCall(2, "mate")).at(-1),
    "Dispatched c-1-a1 on local, branch c-1-a1.",
  );
  const workerFirst = await h.waitForCall(0, "worker");
  assert.equal(lastUser(workerFirst), "[fleet] main on c-1: fix the scrollbar");
  // The emitted system prompt carries each role's contract.
  assert.match(
    workerFirst.find((turn) => turn.role === "system")?.text ?? "",
    /^# Worker role contract$/m,
  );
  const mateFirst = await h.waitForCall(0, "mate");
  assert.match(mateFirst.find((turn) => turn.role === "system")?.text ?? "", /^# Firstmate$/m);
  assert.equal(
    lastUser(woken),
    "[fleet] c-1 done: PR green (re your comment: fix the scrollbar) (card now needs-you)",
  );
  assert.deepEqual(worktrees(), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
  assert.deepEqual(await workers(), ["c-1-a1"]);
  // In the sidebar the worker sits under its mate's workspace, by the card's name.
  assert.deepEqual(await sidebar(), ["fleet-main", "└ one-scrollbar", "fleet-cleo"]);
});

test("a dispatch whose connection drops after the worker started finds it, and a retry starts no other", async () => {
  scriptMate({ host: "flaky" }, { host: "flaky" });
  await mateConnected();
  mate.prompt("ship the scrollbar fix");
  const woken = await h.waitForCall(4, "mate", WORKER_WAIT_MS);

  const results = toolResults(await h.waitForCall(3, "mate"));
  // herdr's answer was lost, but the pane shows that Pi started.
  assert.equal(results.at(-2), "Dispatched c-1-a1 on flaky, branch c-1-a1.");
  const launched = readFileSync(launchArgs(), "utf8").split("\n");
  const token = launched
    .find((arg) => arg.startsWith("--fleet-token="))
    ?.slice("--fleet-token=".length);
  assert.ok(token !== undefined && token !== "", "the worker was launched without a token");
  for (const result of results) {
    assert.ok(!result.includes(token), "a tool result carries the worker token");
    assert.ok(!result.includes("--fleet-token"), "a tool result carries the herdr command line");
  }
  assert.match(
    results.at(-1) ?? "",
    /^(c-1 is already running as c-1-a1 on flaky\.|Found c-1-a1 on flaky already starting\.)$/,
  );
  assert.equal(
    lastUser(woken),
    "[fleet] c-1 done: PR green (re your comment: fix the scrollbar) (card now needs-you)",
  );
  assert.deepEqual(worktrees(), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
  assert.deepEqual(await workers(), ["c-1-a1"]);
  const workerTurns = h.callsOf("worker").at(-1) ?? [];
  assert.equal(
    workerTurns.filter((turn) => turn.text === "[fleet] main on c-1: fix the scrollbar").length,
    1,
  );
});

test("dropping a card stops the worker, archives its unlanded work, and removes the worktree and branches", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "the design changed", landed: false } }),
    "mate",
  );
  h.onModel(() => {
    const tree = `${clone}.worktrees/c-1-a1`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    // Workers name their own branch, as a PR branch.
    git("switch", "-q", "-c", "feat/one-scrollbar");
    writeFileSync(join(tree, "committed.txt"), "one\n");
    git("add", "committed.txt");
    git("commit", "-q", "-m", "work in progress");
    writeFileSync(join(tree, "staged.txt"), "two\n");
    git("add", "staged.txt");
    writeFileSync(join(tree, "committed.txt"), "one\nchanged\n");
    writeFileSync(join(tree, "untracked.txt"), "three\n");
    return { tool: "report", args: { status: "blocked", text: "the design is unclear" } };
  }, "worker");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const archive = `${clone}.archive/c-1-a1.tar.zst`;
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), `c-1 is dropped. Unlanded work is archived in local:${archive}.`);
  assert.deepEqual(worktrees(), ["branch refs/heads/main"]);
  assert.deepEqual(branches(), ["main"]);
  assert.deepEqual(await workers(), []);

  const out = mkdtempSync(join(tmpdir(), "fleet-unpack-"));
  execFileSync("sh", ["-c", `zstd -dc '${archive}' | tar -xf - -C '${out}'`]);
  const unpacked = join(out, "c-1-a1");
  assert.deepEqual(
    readdirSync(unpacked).sort(),
    ["commits.bundle", "manifest.json", "staged.patch", "unstaged.patch", "untracked.tar"].sort(),
  );
  execFileSync("git", ["-C", clone, "bundle", "verify", join(unpacked, "commits.bundle")]);
  assert.match(readFileSync(join(unpacked, "staged.patch"), "utf8"), /staged\.txt/);
  assert.match(readFileSync(join(unpacked, "unstaged.patch"), "utf8"), /\+changed/);
  assert.match(
    execFileSync("tar", ["-tf", join(unpacked, "untracked.tar")], { encoding: "utf8" }),
    /untracked\.txt/,
  );
});

test("a rerun of close after the worktree is gone still deletes the branch and reports the archive", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => {
    mkdirSync(`${clone}.archive`, { recursive: true });
    writeFileSync(`${clone}.archive/c-1-a1.tar.zst`, "archived by the first run");
    execFileSync("git", [
      "-C",
      clone,
      "worktree",
      "remove",
      "--force",
      `${clone}.worktrees/c-1-a1`,
    ]);
    return { tool: "close", args: { card: 1, summary: "the design changed", landed: false } };
  }, "mate");
  h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "unclear" } }), "worker");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const archive = `${clone}.archive/c-1-a1.tar.zst`;
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), `c-1 is dropped. Unlanded work is archived in local:${archive}.`);
  assert.equal(
    execFileSync("git", ["-C", clone, "branch", "--list", "c-1-a1"], { encoding: "utf8" }).trim(),
    "",
  );
});

test("an unreachable host of a replaced attempt does not block closing, and its work stays in place", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "far", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => {
    writeFileSync(join(h.dir, "far-down"), "the host is down\n");
    return {
      tool: "dispatch",
      args: { card: 1, host: "local", task: "fix the scrollbar", replace: true },
    };
  }, "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "the design changed", landed: false } }),
    "mate",
  );
  h.onModel(() => ({ text: "dropped" }), "mate");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.match(
    results.at(-1) ?? "",
    /^c-1 is dropped\. Left in place: far c-1-a1 \(herdr worktree on far failed: .*timed out.*\)\.$/,
  );
  assert.deepEqual(worktrees(), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
});

test("a killed archive step of a replaced attempt aborts the close instead of leaving it in place", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "far", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => {
    writeFileSync(join(h.dir, "far-down"), "flood\n");
    return {
      tool: "dispatch",
      args: { card: 1, host: "local", task: "fix the scrollbar", replace: true },
    };
  }, "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "the design changed", landed: false } }),
    "mate",
  );
  h.onModel(() => ({ text: "dropped" }), "mate");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-1) ?? "", /^sh on far failed: /);
  assert.deepEqual(worktrees(), [
    "branch refs/heads/main",
    "branch refs/heads/c-1-a1",
    "branch refs/heads/c-1-a2",
  ]);
});

test("a host that hangs past the timeout counts as unreachable for a replaced attempt", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "far", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => {
    writeFileSync(join(h.dir, "far-down"), "hang\n");
    return {
      tool: "dispatch",
      args: { card: 1, host: "local", task: "fix the scrollbar", replace: true },
    };
  }, "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "the design changed", landed: false } }),
    "mate",
  );
  h.onModel(() => ({ text: "dropped" }), "mate");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(4, "mate", 120_000));
  assert.match(
    results.at(-1) ?? "",
    /^c-1 is dropped\. Left in place: far c-1-a1 \(herdr worktree on far failed: killed by SIGTERM\)\.$/,
  );
  assert.deepEqual(worktrees(), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
});

test("a branch that cannot be deleted aborts the close, and a rerun finishes it", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } }),
    "mate",
  );
  const lock = `${clone}/.git/refs/heads/c-1-a1.lock`;
  h.onModel(() => {
    writeFileSync(lock, "");
    return { tool: "close", args: { card: 1, summary: "the design changed", landed: false } };
  }, "mate");
  h.onModel(() => {
    rmSync(lock);
    return { tool: "close", args: { card: 1, summary: "the design changed", landed: false } };
  }, "mate");
  h.onModel(() => ({ text: "dropped" }), "mate");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-2) ?? "", /^sh on local failed: /);
  assert.match(results.at(-1) ?? "", /^c-1 is dropped\./);
  assert.deepEqual(worktrees(), ["branch refs/heads/main"]);
  assert.equal(
    execFileSync("git", ["-C", clone, "branch", "--list", "c-1-a1"], { encoding: "utf8" }).trim(),
    "",
  );
});

test("dispatching a card whose worker died restarts it on its own session", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  let asked = 0;
  let returned = 0;
  h.onModel(() => {
    asked = Date.now();
    return { tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } };
  }, "mate");
  h.onModel(() => {
    returned = Date.now();
    return { text: "restarted" };
  }, "mate");
  // The worker waits on a long job, so it ends its run without telling the mate anything.
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  // The first dispatch has returned, so only the worker's Pi still carries these arguments.
  await h.waitForCall(2, "mate", 120_000);

  // Kill only this test's worker: the Pi in the lab pane of attempt c-1-a1.
  const group = await workerGroupOf(lab, "c-1-a1");
  assert.ok(group !== undefined && group > 0);
  process.kill(-group, "SIGKILL");
  // Wait until no Pi runs in the pane.
  const deadline = Date.now() + 30_000;
  while ((await workers()).includes("c-1-a1")) {
    assert.ok(Date.now() < deadline, "the killed worker still runs");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await h.waitForNth((e) => e["type"] === "fleet_connected", 1, "the mate's connection");
  mate.prompt("the worker died; restart it");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "Restarted c-1-a1 on local on its own session, branch c-1-a1.");
  assert.ok(
    returned - asked < RESTART_WAIT_MS,
    `the restart held the mate for ${String(returned - asked)} ms`,
  );
  const resumed = await h.waitForCall(2, "worker", WORKER_WAIT_MS);
  assert.equal(
    lastUser(resumed),
    "[fleet] main on c-1: Your session was restarted. Continue your task from where you stopped.",
  );
  assert.ok(resumed.some((turn) => turn.text === "[fleet] main on c-1: fix the scrollbar"));
  assert.deepEqual(await workers(), ["c-1-a1"]);
});
