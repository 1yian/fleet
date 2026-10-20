// dispatch through herdr (spec sections 11.2 and 25, test 8). A real mate Pi
// with the fleet extension dispatches a real worker Pi into a herdr lab
// session, in its own git worktree. Both use the scripted fake model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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
const FLAKY = fileURLToPath(new URL("../support/flaky-transport.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let clone: string;
let mate: Pi;
beforeEach(async () => {
  cardd = await Cardd.start();
  const mainToken = cardd.addLane("main");
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
  cardd.addProject("site", 2, { local: clone, flaky: clone });
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
      FLEET_HOSTS: JSON.stringify({ flaky: ["node", FLAKY, join(h.dir, "dropped")] }),
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
  assert.equal(
    lastUser(await h.waitForCall(0, "worker")),
    "[fleet] main on c-1: fix the scrollbar",
  );
  assert.equal(lastUser(woken), "[fleet] c-1 done: PR green (re your comment: fix the scrollbar)");
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
  assert.equal(lastUser(woken), "[fleet] c-1 done: PR green (re your comment: fix the scrollbar)");
  assert.deepEqual(worktrees(), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
  assert.deepEqual(await agents(), ["c-1-a1"]);
  const workerTurns = h.callsOf("worker").at(-1) ?? [];
  assert.equal(
    workerTurns.filter((turn) => turn.text === "[fleet] main on c-1: fix the scrollbar").length,
    1,
  );
});
