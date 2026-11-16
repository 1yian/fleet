import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import {
  branchesOf,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
} from "../support/dispatch-lab.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
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
let main: Session;
let mate: Pi;

beforeEach(async () => {
  scratch = new Scratch();
  cardd = await Cardd.start();
  h = await Harness.start();
  const token = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, token);
  main = await cardd.connect(token);
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
  h.onModel(async () => {
    const recorded = check(OPS.complaints.result, await main.call("complaints", {}));
    assert.deepEqual(
      recorded.map(({ text }) => text),
      workerAnswer === "yes" ? [WORKER_SENTENCE] : [],
    );
    return {
      tool: "close",
      args: { card: 2, summary: "Assessment delivered", next: { drop: "nothing to build" } },
    };
  }, "mate");
  if (mateAnswer === "yes")
    h.onModel(() => ({ tool: "complain", args: { text: MATE_SENTENCE, card: 2 } }), "mate");
  h.onModel(() => ({ tool: "complaints", args: {} }), "mate");
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
      /wait for its result, then send the final report/,
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

test("a worker and a mate that answer yes leave one attributed complaint each, which outlives the closed card and its removed worktree and shows in the review", async () => {
  scriptWork("yes", "yes");
  const before = Date.now();
  const results = toolResults(await finishWork(7));

  const worker = h.callsOf("worker");
  assert.ok(worker.length >= 2 && worker.length <= 3);
  assert.equal(asked(worker[0]), 0);
  assert.equal(asked(worker[1]), 0);
  assert.equal(toolResults(worker[1] ?? []).at(-1), "Recorded complaint 1.");
  const mateCalls = h.callsOf("mate");
  assert.equal(asked(mateCalls[3]), 0);
  assert.equal(asked(mateCalls[4]), 1);
  assert.equal(asked(mateCalls[6]), 1);

  const listed = check(OPS.complaints.result, await main.call("complaints", {}));
  assert.deepEqual(
    listed.map(({ at, ...kept }) => ({ ...kept, recent: at >= before && at <= Date.now() })),
    [
      {
        id: 2,
        session: "cnp",
        role: "mate",
        lane: "cnp",
        card: 2,
        project: "fleet",
        text: MATE_SENTENCE,
        recent: true,
      },
      {
        id: 1,
        session: "c-2-a1",
        role: "worker",
        lane: "cnp",
        card: 2,
        project: "fleet",
        text: WORKER_SENTENCE,
        recent: true,
      },
    ],
  );
  const [newest = "", older = "", ...rest] = (results.at(-1) ?? "").split("\n");
  assert.equal(rest.length, 0);
  assert.match(newest, /^#2 \d{4}-\d\d-\d\dT[\d:.]+Z cnp \(mate, lane cnp, c-2, fleet\): /);
  assert.ok(newest.endsWith(MATE_SENTENCE));
  assert.match(older, /^#1 \d{4}-\d\d-\d\dT[\d:.]+Z c-2-a1 \(worker, lane cnp, c-2, fleet\): /);
  assert.ok(older.endsWith(WORKER_SENTENCE));

  const thread = await cardd.thread(2);
  assert.equal(thread.card.status, "done");
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(scratch.root), ["main"]);
  assert.deepEqual(await workersOf(lab), []);
  const written = JSON.stringify(thread.entries);
  assert.equal(written.includes(WORKER_SENTENCE), false);
  assert.equal(written.includes(MATE_SENTENCE), false);
});

test("a worker and a mate that answer no record nothing, add nothing to the card, and finish with no extra model call", async () => {
  scriptWork("no", "no");
  const results = toolResults(await finishWork(6));

  const worker = h.callsOf("worker");
  assert.ok(worker.length >= 1 && worker.length <= 2);
  assert.equal(asked(worker[0]), 0);
  assert.equal(asked(worker[1]), 0);
  const mateCalls = h.callsOf("mate");
  assert.equal(asked(mateCalls[4]), 1);
  assert.equal(results.at(-1), "No complaints.");
  assert.deepEqual(check(OPS.complaints.result, await main.call("complaints", {})), []);

  const thread = await cardd.thread(2);
  assert.equal(thread.card.status, "done");
  assert.deepEqual(
    thread.entries.map((entry) => entry.kind),
    ["comment", "report", "cleanup"],
  );
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(await workersOf(lab), []);
});
