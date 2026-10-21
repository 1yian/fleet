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
const REPORT = "Assessment complete. Implementation belongs to separate cards.\n";

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
      FLEET_PI_ARGS: JSON.stringify([...h.piArgs(), "-e", EXTENSION]),
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

test("normal close delivers an unchanged scout after main coordinates separate implementation, preserving its report", async () => {
  const report = join(scratch.parent, "reports", "assessment.md");
  h.onModel(
    () => ({
      tool: "card_new",
      args: { title: "Assess the lifecycle", name: "assessment", kind: "scout", project: "fleet" },
    }),
    "mate",
  );
  h.onModel(
    () => ({
      tool: "dispatch",
      args: { card: 2, host: "local", task: "Write the read-only assessment." },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(async () => {
    await main.call("comment", {
      card: 2,
      text: "Implementation is assigned elsewhere. Close the delivered assessment normally.",
    });
    return { tool: "close", args: { card: 2, summary: `Assessment delivered: ${report}` } };
  }, "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
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
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("assess the lifecycle");

  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "c-2 is done.");
  const outcome = await main.waitForEntry(
    (entry) => entry.kind === "cleanup",
    "the delivered outcome",
  );
  assert.equal(outcome.fields["outcome"], "done");
  assert.equal(outcome.body, `Assessment delivered: ${report}`);
  assert.equal((await cardd.thread(2)).card.status, "done");
  assert.equal(readFileSync(report, "utf8"), REPORT);
  assert.equal(existsSync(`${scratch.root}.archive`), false);
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(scratch.root), ["main"]);
  assert.deepEqual(await workersOf(lab), []);
});
