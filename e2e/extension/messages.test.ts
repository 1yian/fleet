import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { lastUser } from "../support/dispatch-lab.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  cardd.addProject("web", { maverick: "/clones/web" });
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, mainToken);
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function asMain(op: string, args: unknown): Promise<unknown> {
  const { status, body } = await cardd.post(mainToken, op, args);
  assert.equal(status, 200, JSON.stringify(body));
  return Reflect.get(Object(body), "value");
}

test("main reads a worker's report after its comment as one line: card name, status, update, and no echo", async () => {
  h.onModel(() => ({ text: "noted" }), "mate");
  h.onModel(() => ({ text: "noted" }), "mate");
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");

  const card = check(
    CardSchema,
    await asMain("card.new", {
      title: "Ban code comments",
      name: "ban-code-comments",
      kind: "ship",
      project: "web",
    }),
  );
  const begun = await asMain("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "Add a lint rule that bans code comments",
  });
  const worker = await cardd.connect(check(OPS["attempt.begin"].result, begun).token);
  await worker.waitForEntries(1);

  await worker.call("report", { status: "working", text: "Reading the lint config" });
  assert.equal(
    lastUser(await h.waitForCall(0, "mate", WAIT_MS)),
    "[fleet] c-1 ban-code-comments working: Reading the lint config",
  );

  await asMain("comment", { card: card.id, text: "Put the rule in eslint.config.js" });
  await worker.waitForEntries(2);
  await worker.call("report", {
    status: "working",
    text: "The no-comments lint rule is in eslint.config.js",
  });
  assert.equal(
    lastUser(await h.waitForCall(1, "mate", WAIT_MS)),
    "[fleet] c-1 ban-code-comments working: The no-comments lint rule is in eslint.config.js",
  );

  await asMain("comment", { card: card.id, text: "Stop and report what blocks you" });
  await worker.waitForEntries(3);
  await worker.call("report", { status: "blocked", text: "The lint gate is red on main" });
  assert.equal(
    lastUser(await h.waitForCall(2, "mate", WAIT_MS)),
    "[fleet] c-1 ban-code-comments blocked: The lint gate is red on main (card now with-mate)",
  );
  await worker.close();
});
