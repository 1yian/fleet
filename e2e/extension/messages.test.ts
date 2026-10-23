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
  await asMain("comment", { card: card.id, text: "Put the rule in eslint.config.js" });
  await worker.waitForEntries(2);
  await worker.call("report", {
    status: "working",
    text: "The no-comments lint rule is in eslint.config.js",
  });
  await asMain("comment", { card: card.id, text: "Stop and report what blocks you" });
  await worker.waitForEntries(3);
  await worker.call("report", { status: "blocked", text: "The lint gate is red on main" });
  await h.waitForCall(0, "mate", WAIT_MS);
  const lines = (): string[] =>
    h
      .callsOf("mate")
      .flatMap((turns) => turns.filter((turn) => turn.role === "user").map((turn) => turn.text))
      .filter((text) => text.startsWith("[fleet] c-1"));
  const deadline = Date.now() + WAIT_MS;
  while (new Set(lines()).size < 3) {
    assert.ok(Date.now() < deadline, "timed out waiting for the batch and the blocked report");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(
    [...new Set(lines())],
    [
      "[fleet] c-1 ban-code-comments working: Reading the lint config",
      "[fleet] c-1 ban-code-comments working: The no-comments lint rule is in eslint.config.js",
      "[fleet] c-1 ban-code-comments blocked: The lint gate is red on main (card now with-mate)",
    ],
  );
  await worker.close();
});

test("a captain's board comment on a card in a second mate's lane reaches main alone, with the lane named", async () => {
  h.onModel(() => ({ text: "noted" }), "mate");
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const theirs = check(
    CardSchema,
    await cleo.call("card.new", { title: "Ads", name: "ads", kind: "scout" }),
  );
  const mine = check(
    CardSchema,
    await asMain("card.new", { title: "Plan", name: "plan", kind: "scout" }),
  );

  assert.equal(await cardd.act(theirs.id, { kind: "comment", text: "Is the budget safe?" }), 200);
  assert.equal(
    lastUser(await h.waitForCall(0, "mate", WAIT_MS)),
    `[fleet] captain on c-${String(theirs.id)} ads (in cleo's lane): Is the budget safe?${await captainSuffix(theirs.id)}`,
  );
  assert.equal(await cardd.act(mine.id, { kind: "comment", text: "Start with the plan" }), 200);
  assert.equal(
    lastUser(await h.waitForCall(1, "mate", WAIT_MS)),
    `[fleet] captain on c-${String(mine.id)} plan: Start with the plan${await captainSuffix(mine.id)}`,
  );

  await asMain("comment", { lane: "cleo", text: "The captain asks if the budget is safe" });
  await cleo.waitForEntry((entry) => entry.author === "mate:main", "main's relay");
  assert.equal(cleo.entries.filter(({ entry }) => entry.author === "captain").length, 0);
});

async function captainSuffix(card: number): Promise<string> {
  const entry = (await cardd.thread(card)).entries.findLast((each) => each.author === "captain");
  assert.ok(entry);
  const id = `r-${String(entry.id)}`;
  const on = `card=${String(card)}`;
  return ` (reply owed by main, ${id}: answer the captain on the board with comment(${on}, text, replyTo="${id}") or hold(${on}, question, replyTo="${id}"))`;
}
