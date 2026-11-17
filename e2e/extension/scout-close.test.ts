import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import {
  branchesOf,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
} from "../support/dispatch-lab.ts";
import { Harness, type Pi } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch } from "../support/scratch.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const REPORT = "Assessment complete. The lifecycle inventory is current.\n";

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
    [],
    true,
  );
});

afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const DISPATCH_SCOUT = {
  tool: "dispatch",
  args: {
    title: "Assess the lifecycle",
    name: "assessment",
    kind: "scout",
    project: "fleet",
    intent: "Fix the scrollbar",
    host: "local",
    task: "Write the read-only assessment.",
  },
};

function scriptDeliveredAssessment(report: string): void {
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => DISPATCH_SCOUT, "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => {
    mkdirSync(join(scratch.parent, "reports"));
    writeFileSync(report, REPORT);
    return {
      tool: "report",
      args: {
        status: "done",
        text: `Report written: ${report}. No project changes or unlanded work.`,
      },
    };
  }, "worker");
}

test("normal close delivers an unchanged scout once main holds its decision in main's lane, preserving its report", async () => {
  const report = join(scratch.parent, "reports", "assessment.md");
  scriptDeliveredAssessment(report);
  h.onModel(async () => {
    await main.call("comment", {
      card: 2,
      text: "Implementation is the captain's call. Close the delivered assessment normally.",
    });
    await main.call("card.new", {
      title: "Build the scrollbar fix or drop it?",
      name: "scrollbar-decision",
      kind: "captain",
    });
    await main.call("hold", {
      card: 3,
      question: "Build the scrollbar fix or drop it?",
      options: ["Build it", "Drop it"],
    });
    return { tool: "board", args: {} };
  }, "mate");
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => {
    return {
      tool: "close",
      args: {
        card: 2,
        summary: `Assessment delivered: ${report}`,
        next: { decision: 3 },
      },
    };
  }, "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("assess the lifecycle");

  const results = toolResults(await h.waitForCall(6, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "c-2 is done.");
  assert.equal((await cardd.thread(3)).card.lane, "main");
  assert.equal((await cardd.thread(3)).card.status, "needs-you");
  const outcome = await main.waitForEntry(
    (entry) => entry.kind === "cleanup",
    "the delivered outcome",
  );
  assert.equal(outcome.fields["outcome"], "done");
  assert.deepEqual(outcome.fields["next"], { decision: 3 });
  assert.equal(outcome.body, `Next: the captain decides on c-3.\nAssessment delivered: ${report}`);
  assert.equal((await cardd.thread(2)).card.status, "done");
  assert.equal(readFileSync(report, "utf8"), REPORT);
  assert.equal(existsSync(`${scratch.root}.archive`), false);
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(scratch.root), ["main"]);
  assert.deepEqual(await workersOf(lab), []);
});

test("a close without a disposition leaves the scout open, then the mate reads its report and closes it as delivered", async () => {
  const report = join(scratch.parent, "reports", "assessment.md");
  scriptDeliveredAssessment(report);
  const summary = `Assessment delivered: ${report}. The lifecycle inventory is current.`;
  h.onModel(() => ({ tool: "close", args: { card: 2, summary } }), "mate");
  let workersAtRefusal: string[] = [];
  let statusAtRefusal = "";
  h.onModel(async () => {
    workersAtRefusal = await workersOf(lab);
    statusAtRefusal = (await cardd.thread(2)).card.status;
    return { tool: "read", args: { path: report } };
  }, "mate");
  const delivered = {
    evidence: `Read ${report}; findings relayed to main on the card.`,
    disposition: "The inventory request is complete. No build or unresolved decision remains.",
  };
  h.onModel(() => ({ tool: "close", args: { card: 2, summary, next: { delivered } } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("assess the lifecycle");

  const results = toolResults(await h.waitForCall(6, "mate", WORKER_WAIT_MS));
  assert.match(
    results.at(-3) ?? "",
    /^c-2 is a scout: it closes Done only when the close says what happens next\. Pass next with exactly one of build=.*decision=.*drop=/s,
  );
  assert.equal(workersAtRefusal.length, 1);
  assert.equal(statusAtRefusal, "with-mate");
  assert.equal(results.at(-1), "c-2 is done.");
  const outcome = await main.waitForEntry(
    (entry) => entry.kind === "cleanup",
    "the delivered outcome",
  );
  assert.match(results.at(-2) ?? "", /Assessment complete/);
  assert.deepEqual(outcome.fields["next"], { delivered });
  assert.equal(
    outcome.body,
    `Delivered: ${delivered.evidence}\nDisposition: ${delivered.disposition}\n${summary}`,
  );
  assert.equal(readFileSync(report, "utf8"), REPORT);
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(await workersOf(lab), []);
});
