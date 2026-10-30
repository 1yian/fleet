import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, messageText, optionalString, parseRecord } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
const OUTCOME = "Captain, the parser fix is ready for review: https://github.com/acme/api/pull/7";
const EVIDENCE = process.env["YIELD_EVIDENCE_DIR"];

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, mainToken);
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function settled(n = 1): Promise<void> {
  const event = await h.waitForNth((each) => each["type"] === "settled", n, "the mate to settle");
  assert.equal(event["aborted"], false);
}

async function takenIn(session: string, count: number): Promise<void> {
  const db = new DatabaseSync(cardd.db, { readOnly: true });
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = db
        .prepare("SELECT state, intake FROM deliveries WHERE session = ? ORDER BY entry")
        .all(session);
      if (rows.length === count && rows.every((row) => row["intake"] === "taken")) {
        assert.deepEqual(
          rows.map((row) => row["state"]),
          rows.map(() => "acknowledged"),
        );
        return;
      }
      assert.ok(Date.now() < deadline, `delivery was not acknowledged: ${JSON.stringify(rows)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    db.close();
  }
}

async function assistantText(): Promise<string[]> {
  const session = await h.waitFor((event) => event["type"] === "session", "the session file");
  return readFileSync(optionalString(session, "file") ?? "", "utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseRecord)
    .map((entry) => entry["message"])
    .filter((message) => isRecord(message) && message["role"] === "assistant")
    .filter(isRecord)
    .map(messageText);
}

async function screenWith(pane: string, text: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const screen = await lab.screen(pane);
    if (screen.includes(text)) return screen;
    assert.ok(Date.now() < deadline, `screen never showed ${text}: ${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function keep(name: string, pane: string): Promise<string> {
  const screen = await lab.screen(pane);
  if (EVIDENCE !== undefined) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
  }
  return screen;
}

test("main yields without chat or a tool placeholder, acknowledges the notification, then delivers real news", async () => {
  h.onModel(() => ({ tool: "yield" }), "mate");
  h.onModel(() => ({ text: OUTCOME }), "mate");
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");

  await cleo.call("comment", { lane: "cleo", text: "Validation is still running, no news yet." });
  await settled();
  await takenIn("main", 1);
  assert.equal(h.callsOf("mate").length, 1, "yield must not request another model response");
  assert.deepEqual(await assistantText(), [""]);
  const quiet = await keep("1-silent-yield-calm-off", pane);
  assert.doesNotMatch(quiet, /shipshape|\byield\b|\bok\b|Error/i);

  await cleo.call("comment", { lane: "cleo", text: "The parser fix is ready for review." });
  await settled(2);
  await takenIn("main", 2);
  await screenWith(pane, "Captain, the parser fix is ready for review:");
  assert.deepEqual(await assistantText(), ["", OUTCOME]);
  assert.equal(h.callsOf("mate").length, 2);
  await keep("2-meaningful-outcome", pane);
});

test("yield leaves a queued fleet outcome for the next model call", async () => {
  h.onModel(() => ({ tool: "slow_tool" }), "mate");
  h.onModel(() => ({ tool: "yield" }), "mate");
  h.onModel(() => ({ text: OUTCOME }), "mate");
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");
  await cleo.call("comment", { lane: "cleo", text: "Validation is still running." });
  await h.waitFor((event) => event["type"] === "tool_waiting", "the first tool");
  await cleo.call("comment", {
    lane: "cleo",
    text: "The queued parser fix is ready.",
    later: true,
  });
  await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the queued outcome");
  h.releaseTool();
  await settled();
  await takenIn("main", 2);
  const turns = await h.waitForCall(2, "mate");
  assert.match(turns.at(-1)?.text ?? "", /The queued parser fix is ready/);
  assert.deepEqual(await assistantText(), ["", "", OUTCOME]);
  await screenWith(pane, "Captain, the parser fix is ready for review:");
});

test("a second mate answers a required reply on its card before yielding silently", async () => {
  const main = await cardd.connect(mainToken);
  try {
    const token = cardd.addLane("leo", "main");
    scratch.addLane("leo", { url: cardd.url, token, args: [...mateArgs(h), "-e", PROBE] });
    h.onModel((turns) => {
      const id = /reply owed, (r-\d+)/.exec(turns.at(-1)?.text ?? "")?.[1] ?? "missing";
      return { tool: "comment", args: { lane: "leo", text: "Validation continues.", replyTo: id } };
    }, "mate");
    h.onModel(() => ({ tool: "yield" }), "mate");
    scratch.fleet(["up", "leo"], { HERDR_SESSION: lab.name });
    await h.waitFor((event) => event["type"] === "fleet_connected", "leo to connect");
    await main.call("comment", { lane: "leo", text: "Is validation running?", reply: true });
    await settled();
    await takenIn("leo", 1);
    const answer = await main.waitForEntry((entry) => entry.author === "mate:leo", "leo's reply");
    assert.equal(answer.body, "Validation continues.");
    assert.match(String(answer.fields["replyTo"]), /^r-\d+$/);
    assert.deepEqual(
      (await cardd.board()).cards.find((card) => card.id === answer.card)?.replies,
      [],
    );
    assert.deepEqual(await assistantText(), ["", ""]);
    assert.equal(h.callsOf("mate").length, 2);
  } finally {
    await main.close();
  }
});
