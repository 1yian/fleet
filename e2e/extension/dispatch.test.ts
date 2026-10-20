// dispatch through herdr (spec sections 11.2 and 25, test 8). A real mate Pi
// with the fleet extension dispatches a real worker Pi into a herdr lab
// session, in its own git worktree. Both use the scripted fake model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

// herdr starts each worker Pi cold, which can take tens of seconds on a busy CI runner.
const WORKER_WAIT_MS = 60_000;
const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SWITCH = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));
const FLAKY = fileURLToPath(new URL("../support/flaky-transport.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let clone: string;
let mate: Pi;
let home: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  home = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const mainToken = cardd.addLane("main", undefined, home);
  clone = join(mkdtempSync(join(tmpdir(), "fleet-clone-")), "site");
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  execFileSync("git", [
    "-C",
    clone,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  cardd.addProject("site", 2, { local: clone, flaky: clone, far: clone });
  h = await Harness.start();
  lab = await HerdrLab.start({
    ...h.piEnv("worker"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_ARGV_FILE: launchArgs(),
  });
  mate = h.startPi(
    "main",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: mainToken,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      FLEET_PI_ARGS: JSON.stringify([...h.piArgs(), "-e", EXTENSION]),
      FLEET_HOSTS: JSON.stringify({
        flaky: ["node", FLAKY, join(h.dir, "dropped")],
        far: ["node", SWITCH, join(h.dir, "far-down")],
      }),
    },
    [EXTENSION],
  );
});
afterEach(async () => {
  // Stop everything even if one part fails, so no process outlives the test.
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const launchArgs = (): string => join(h.dir, "worker-args");
const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);
const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
const worktrees = (): string[] =>
  execFileSync("git", ["-C", clone, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("branch "));
const agents = async (): Promise<string[]> =>
  records((await lab.run(["agent", "list"]))["agents"]).flatMap((agent) =>
    typeof agent["name"] === "string" ? [agent["name"]] : [],
  );

const mateConnected = () =>
  h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");

function scriptMate(...dispatches: { host: string }[]): void {
  h.onModel(
    () => ({
      tool: "card_new",
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
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
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "PR green" } }), "worker");
}

test("dispatch starts a worker in its own worktree, and the worker's report reaches the mate", async () => {
  scriptMate({ host: "local" });
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
  assert.deepEqual(await agents(), ["c-1-a1"]);
});

test("a dispatch retry after a lost connection finds the worker that already started", async () => {
  scriptMate({ host: "flaky" }, { host: "flaky" });
  await mateConnected();
  mate.prompt("ship the scrollbar fix");
  const woken = await h.waitForCall(4, "mate", WORKER_WAIT_MS);

  const results = toolResults(await h.waitForCall(3, "mate"));
  assert.match(results.at(-2) ?? "", /^herdr agent on flaky failed/);
  const launched = readFileSync(launchArgs(), "utf8").split("\n");
  const token = launched[launched.indexOf("--fleet-token") + 1];
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
  assert.deepEqual(await agents(), ["c-1-a1"]);
  const workerTurns = h.callsOf("worker").at(-1) ?? [];
  assert.equal(
    workerTurns.filter((turn) => turn.text === "[fleet] main on c-1: fix the scrollbar").length,
    1,
  );
});

test("dropping a card stops the worker, archives its unlanded work, and removes the worktree", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "card_drop", args: { card: 1, reason: "the design changed" } }), "mate");
  h.onModel(() => {
    const tree = `${clone}.worktrees/c-1-a1`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
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
  assert.deepEqual(await agents(), []);

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

test("a rerun of cleanup after the worktree is gone still deletes the branch and reports the archive", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
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
    return { tool: "card_drop", args: { card: 1, reason: "the design changed" } };
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
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
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
  h.onModel(() => ({ tool: "card_drop", args: { card: 1, reason: "the design changed" } }), "mate");
  h.onModel(() => ({ text: "dropped" }), "mate");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.match(
    results.at(-1) ?? "",
    /^c-1 is dropped\. Unlanded work is archived in local:.*c-1-a2\.tar\.zst\. Left in place: far c-1-a1 \(herdr worktree on far failed: .*timed out.*\)\.$/,
  );
  assert.deepEqual(worktrees(), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
});

test("a killed archive step of a replaced attempt aborts the close instead of leaving it in place", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
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
  h.onModel(() => ({ tool: "card_drop", args: { card: 1, reason: "the design changed" } }), "mate");
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
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
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
  h.onModel(() => ({ tool: "card_drop", args: { card: 1, reason: "the design changed" } }), "mate");
  h.onModel(() => ({ text: "dropped" }), "mate");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(4, "mate", 120_000));
  assert.match(
    results.at(-1) ?? "",
    /^c-1 is dropped\. Unlanded work is archived in local:.*c-1-a2\.tar\.zst\. Left in place: far c-1-a1 \(herdr worktree on far failed: killed by SIGTERM\)\.$/,
  );
  assert.deepEqual(worktrees(), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
});

test("a branch that cannot be deleted aborts the close, and a rerun finishes it", async () => {
  h.onModel(
    () => ({
      tool: "card_new",
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
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
    return { tool: "card_drop", args: { card: 1, reason: "the design changed" } };
  }, "mate");
  h.onModel(() => {
    rmSync(lock);
    return { tool: "card_drop", args: { card: 1, reason: "the design changed" } };
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
      args: { title: "Users see one scrollbar", kind: "ship", project: "site" },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix the scrollbar" } }),
    "mate",
  );
  h.onModel(() => ({ text: "restarted" }), "mate");
  // The worker waits on a long job, so it ends its run without telling the mate anything.
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  await mateConnected();
  mate.prompt("ship the scrollbar fix");
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  // The first dispatch has returned, so only the worker's Pi still carries these arguments.
  await h.waitForCall(2, "mate", 120_000);

  // Kill only this test's worker: the Pi in the lab pane that hosts agent c-1-a1.
  const agent = records((await lab.run(["agent", "list"]))["agents"]).find(
    (each) => each["name"] === "c-1-a1",
  );
  const info = await lab.run(["pane", "process-info", "--pane", String(agent?.["pane_id"])]);
  const [pi] = records(records([info["process_info"]])[0]?.["foreground_processes"]).map((each) =>
    Number(each["pid"]),
  );
  assert.ok(pi !== undefined && pi > 0);
  process.kill(pi, "SIGKILL");
  // Wait until herdr sees the pane back at its shell.
  const deadline = Date.now() + 30_000;
  while ((await agents()).includes("c-1-a1")) {
    assert.ok(Date.now() < deadline, "herdr still lists the killed worker");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await h.waitForNth((e) => e["type"] === "fleet_connected", 1, "the mate's connection");
  mate.prompt("the worker died; restart it");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "Restarted c-1-a1 on local on its own session, branch c-1-a1.");
  const resumed = await h.waitForCall(2, "worker", WORKER_WAIT_MS);
  assert.equal(
    lastUser(resumed),
    "[fleet] main on c-1: Your session was restarted. Continue your task from where you stopped.",
  );
  assert.ok(resumed.some((turn) => turn.text === "[fleet] main on c-1: fix the scrollbar"));
  assert.deepEqual(await agents(), ["c-1-a1"]);
});
