import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let ghostToken: string;
const workerFleetArgs = (token: string): string[] => {
  assert.match(token, /^-/);
  return [`--fleet-url=${cardd.url}`, `--fleet-token=${token}`, "--fleet-role=worker"];
};
beforeEach(async () => {
  cardd = await Cardd.start();
  cardd.dashTokens(["worker:c-1-a1"]);
  h = await Harness.start();
  mkdirSync(join(h.dir, "agent", "extensions"), { recursive: true });
  execFileSync("herdr", ["integration", "install", "pi"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(h.dir, "agent") },
  });
  here = new Scratch();
  configureMain(here, cardd.url, cardd.addLane("main", undefined, here.root));
  ghostToken = cardd.addLane("ghost", "main");
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function agentOf(pane: string): Promise<{ status: string }> {
  const got = await lab.run(["pane", "get", pane]);
  const info = isRecord(got["pane"]) ? got["pane"] : {};
  return { status: String(info["agent_status"]) };
}

async function until(
  pane: string,
  what: string,
  done: (state: { status: string }) => boolean,
): Promise<{ status: string }> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const state = await agentOf(pane);
    if (done(state)) return state;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const PAUSE = () => ({
  tool: "report",
  args: {
    status: "paused",
    text: "waiting",
    until: new Date(Date.now() + 3_600_000).toISOString(),
  },
});

async function workerPane(
  title: string,
  builtinTools = false,
): Promise<{
  readonly pane: string;
  readonly mate: Awaited<ReturnType<Cardd["connect"]>>;
  readonly card: number;
  readonly token: string;
}> {
  cardd.addProject("web", { maverick: here.root });
  const mate = await cardd.connect(ghostToken);
  const card = check(
    CardSchema,
    await mate.call("card.new", { title, kind: "scout", project: "web" }),
  );
  const { token } = check(
    OPS["attempt.begin"].result,
    await mate.call("attempt.begin", { card: card.id, host: "maverick", task: "investigate" }),
  );
  const pane = await startMain(lab, here, h, false, [
    ...mateArgs(h).filter((arg) => !builtinTools || arg !== "--no-builtin-tools"),
    ...workerFleetArgs(token),
  ]);
  return { pane, mate, card: card.id, token };
}

async function stays(pane: string, status: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal((await agentOf(pane)).status, status);
}

test("a worker whose last report was blocked reads blocked until a later working report", async () => {
  h.onModel(
    () => ({ tool: "report", args: { status: "blocked", text: "missing access" } }),
    "mate",
  );
  h.onModel(() => ({ text: "waiting" }), "mate");
  h.onModel(
    () => ({ tool: "report", args: { status: "working", text: "access restored" } }),
    "mate",
  );
  h.onModel(PAUSE, "mate");
  h.onModel(() => ({ text: "carrying on" }), "mate");
  const { pane, mate, card } = await workerPane("blocked report");
  await until(pane, "the blocked report to block the worker", (s) => s.status === "blocked");
  await stays(pane, "blocked");
  await mate.call("comment", { card, text: "access restored, carry on" });
  await until(pane, "a working report to clear the block", (s) => s.status === "idle");
  await stays(pane, "idle");
});

test("a worker that is idle after a Pi error in its last turn reads blocked", async () => {
  h.onModel(() => ({ fail: "Cannot find module '@earendil-works/pi-coding-agent'" }), "mate");
  const { pane } = await workerPane("pi error");
  await until(pane, "the Pi error to block the worker", (s) => s.status === "blocked");
  await stays(pane, "blocked");
});

test("a worker whose last turn failed only on the model does not read blocked", async () => {
  h.onModel(() => ({ fail: "You exceeded your current quota, please check your plan" }), "mate");
  const { pane } = await workerPane("model error");
  await h.waitForNth((event) => event["type"] === "settled", 1, "the failed turn to settle");
  await until(pane, "the worker to settle idle", (s) => s.status === "idle");
  await stays(pane, "idle");
});

test("a worker with an owed reply or an owed decision does not read blocked", async () => {
  h.onModel(
    () => ({
      tool: "report",
      args: { status: "needs-decision", key: "enable", text: "enable Haiku?" },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "waiting for the decision" }), "mate");
  h.onModel(PAUSE, "mate");
  h.onModel(() => ({ text: "noted the question" }), "mate");
  const { pane, mate, card } = await workerPane("owed");
  await mate.waitForEntry((entry) => entry.fields["status"] === "needs-decision", "the report");
  await until(pane, "the worker to settle idle", (s) => s.status === "idle");
  await stays(pane, "idle");
  await mate.call("comment", { card, text: "Which port?", reply: true });
  await h.waitForNth(
    (event) => event["type"] === "settled" && event["aborted"] === false,
    2,
    "the question turn to settle",
  );
  await stays(pane, "idle");
});

test("a worker woken by a job result that ends its turn without a handoff does not read blocked", async () => {
  h.onModel(
    () => ({ tool: "report", args: { status: "working", text: "merged, deploying" } }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "run_long", args: { label: "deploy", command: "echo dev ok" } }),
    "mate",
  );
  h.onModel(() => ({ text: "waiting for the deploy" }), "mate");
  h.onModel(() => ({ text: "dev is up, QA is still pending" }), "mate");
  h.onModel(() => ({ text: "still waiting on QA" }), "mate");
  const { pane, mate } = await workerPane("job result");
  await mate.waitForEntry((entry) => entry.fields["status"] === "stopped", "the stopped report");
  await until(pane, "the worker to settle idle", (s) => s.status === "idle");
  await stays(pane, "idle");
});

test("a worker whose tools fail but whose turn ends normally does not read blocked", async () => {
  h.onModel(() => ({ tool: "bash", args: { command: "exit 7" } }), "mate");
  h.onModel((turns) => {
    assert.match(turns.at(-1)?.text ?? "", /exited with code 7/);
    return { tool: "read", args: { path: "missing-tool-error-guard.txt" } };
  }, "mate");
  h.onModel((turns) => {
    assert.match(turns.at(-1)?.text ?? "", /ENOENT/);
    return PAUSE();
  }, "mate");
  h.onModel(() => ({ text: "tool failures handled, waiting" }), "mate");
  const { pane } = await workerPane("tool errors", true);
  await h.waitForNth((event) => event["type"] === "settled", 1, "the healthy turn to settle");
  await until(pane, "the worker to settle idle after tool failures", (s) => s.status === "idle");
  await stays(pane, "idle");
});

test("a worker whose last turn failed with an HTTP 400 provider error does not read blocked", async () => {
  h.onModel(() => ({ fail: "400 invalid_request_error: messages must not be empty" }), "mate");
  const { pane } = await workerPane("provider 400");
  await h.waitForNth((event) => event["type"] === "settled", 1, "the failed turn to settle");
  await until(pane, "the worker to settle idle", (s) => s.status === "idle");
  await stays(pane, "idle");
});

test("a worker that reported blocked then ended a healthy turn with an automatic stopped report reads idle", async () => {
  h.onModel(
    () => ({ tool: "report", args: { status: "blocked", text: "missing access" } }),
    "mate",
  );
  h.onModel(() => ({ text: "waiting" }), "mate");
  h.onModel(() => ({ text: "looking into it" }), "mate");
  h.onModel(() => ({ text: "still looking into it" }), "mate");
  const { pane, mate, card } = await workerPane("blocked then stopped");
  await until(pane, "the blocked report to block the worker", (s) => s.status === "blocked");
  await mate.call("comment", { card, text: "access restored, carry on" });
  await mate.waitForEntry((entry) => entry.fields["status"] === "stopped", "the stopped report");
  await until(pane, "the stopped report to clear the block", (s) => s.status === "idle");
  await stays(pane, "idle");
});
