import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import {
  branchesOf,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
} from "../support/dispatch-lab.ts";
import { Harness, poll, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch } from "../support/scratch.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const QUESTION = "Did anything about the system annoy you?";
const WORKER_SENTENCE = "The pipeline wait shows no progress, so I could not tell it from a hang.";
const MATE_SENTENCE = "Closing a card prints the clone refresh in one long line.";

let scratch: Scratch;
let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let mate: Pi;

beforeEach(async () => {
  scratch = new Scratch();
  cardd = await Cardd.start();
  h = await Harness.start();
  const token = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, token);
  await cardd.connect(token);
  const cnpToken = cardd.addLane("cnp", "main");
  scratch.addLane("cnp", { url: cardd.url, token: cnpToken });
  cardd.addProject("fleet", { local: scratch.root });
  lab = await HerdrLab.start({
    ...h.piEnv("worker"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  mate = h.startPi(
    "cnp",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: cnpToken,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      FLEET_PI_ARGS: JSON.stringify(h.piArgs()),
    },
    [EXTENSION],
  );
});

afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const filedBy = (count: number) =>
  poll(
    () => (cardd.gh.issues().length >= count ? cardd.gh.issues() : undefined),
    `${String(count)} filed issue(s)`,
  );
const asked = (turns: Turn[] | undefined): number =>
  (turns ?? []).filter((turn) => turn.role === "user" && turn.text.includes(QUESTION)).length;

function scriptWork(workerAnswer: "yes" | "no", mateAnswer: "yes" | "no"): void {
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Assess the lifecycle",
        name: "assessment",
        kind: "scout",
        project: "fleet",
        intent: "Assess it",
        host: "local",
        task: "Write the read-only assessment.",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({
      tool: "close",
      args: { card: 2, summary: "Assessment delivered", next: { drop: "nothing to build" } },
    }),
    "mate",
  );
  if (mateAnswer === "yes")
    h.onModel(() => ({ tool: "complain", args: { text: MATE_SENTENCE, card: 2 } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  if (workerAnswer === "yes")
    h.onModel(() => {
      assert.match(
        h.callsOf("worker")[0]?.find((turn) => turn.role === "system")?.text ?? "",
        /Did anything about the system annoy you\?/,
      );
      return { tool: "complain", args: { text: WORKER_SENTENCE } };
    }, "worker");
  h.onModel(() => {
    assert.match(
      h.callsOf("worker")[0]?.find((turn) => turn.role === "system")?.text ?? "",
      /Before a final `done`, `blocked`, or `failed`, ask yourself once:[^\n]+`complain` once, then report/,
    );
    return {
      tool: "report",
      args: { status: "done", text: "Assessment complete. No project changes." },
    };
  }, "worker");
  h.onModel(() => ({ text: "done" }), "worker");
}

async function finishWork(mateCalls: number): Promise<Turn[]> {
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("assess the lifecycle");
  return h.waitForCall(mateCalls - 1, "mate", WORKER_WAIT_MS);
}

test("a worker and a mate that answer yes file one attributed issue each, which outlives the closed card and its removed worktree", async (t) => {
  const release = cardd.gh.holdIssues();
  t.after(release);
  scriptWork("yes", "yes");
  const before = Date.now();
  await finishWork(6);

  const worker = h.callsOf("worker");
  assert.ok(worker.length >= 2 && worker.length <= 3);
  assert.equal(asked(worker[0]), 0);
  assert.equal(asked(worker[1]), 0);
  assert.equal(
    toolResults(worker[1] ?? []).at(-1),
    "Accepted by cardd for filing as a GitHub issue. Carry on.",
  );
  const mateCalls = h.callsOf("mate");
  assert.equal(asked(mateCalls[3]), 0);
  assert.equal(asked(mateCalls[4]), 1);
  assert.equal(asked(mateCalls[5]), 1);
  assert.equal(
    toolResults(mateCalls[5] ?? []).at(-1),
    "Accepted by cardd for filing as a GitHub issue. Carry on.",
  );

  const thread = await cardd.thread(2);
  assert.equal(thread.card.status, "done");
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(scratch.root), ["main"]);
  assert.deepEqual(await workersOf(lab), []);
  await poll(() => cardd.gh.calls()[1], "both pending GitHub calls");
  assert.deepEqual(cardd.gh.issues(), []);
  release();

  const issues = await filedBy(2);
  const details = (title: string) => {
    const issue = issues.find((each) => each.title === title);
    assert.ok(issue);
    assert.equal(issue.repo, "github.com/1yian/fleet");
    const lines = issue.body.split("\n").filter((line) => line.startsWith("- "));
    const at = Date.parse((lines[0] ?? "").replace("- Time: ", ""));
    assert.ok(at >= before && at <= Date.now());
    return lines.slice(1);
  };
  assert.deepEqual(details(MATE_SENTENCE), [
    "- Role: mate",
    "- Lane: `cnp`",
    "- Card: c-2",
    "- Project: `fleet`",
  ]);
  assert.deepEqual(details(WORKER_SENTENCE), [
    "- Role: worker",
    "- Lane: `cnp`",
    "- Card: c-2",
    "- Project: `fleet`",
  ]);

  const written = JSON.stringify((await cardd.thread(2)).entries);
  assert.equal(written.includes(WORKER_SENTENCE), false);
  assert.equal(written.includes(MATE_SENTENCE), false);
});

test("a worker and a mate that answer no file nothing, add nothing to the card, and finish with no extra model call", async () => {
  scriptWork("no", "no");
  await finishWork(5);

  const worker = h.callsOf("worker");
  assert.ok(worker.length >= 1 && worker.length <= 2);
  assert.equal(asked(worker[0]), 0);
  assert.equal(asked(worker[1]), 0);
  const mateCalls = h.callsOf("mate");
  assert.equal(asked(mateCalls[4]), 1);
  assert.deepEqual(cardd.gh.calls(), []);
  assert.deepEqual(cardd.gh.issues(), []);

  const thread = await cardd.thread(2);
  assert.equal(thread.card.status, "done");
  assert.deepEqual(
    thread.entries.map((entry) => entry.kind),
    ["comment", "report", "cleanup"],
  );
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(await workersOf(lab), []);
});
