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
        .prepare("SELECT state FROM deliveries WHERE session = ? ORDER BY entry")
        .all(session);
      if (rows.length === count && rows.every((row) => row["state"] === "acknowledged")) {
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

const NOTE = "Validation is still running, nothing for the captain.";
const NOTE_CALL = { tool: "comment", args: { lane: "cleo", text: NOTE } };

async function noteReaches(): Promise<void> {
  const note = await cleo.waitForEntry((entry) => entry.body === NOTE, "main's comment to cleo");
  assert.equal(note.author, "mate:main");
}

for (const [place, move] of [
  ["a comment, then yield", { ...NOTE_CALL, alongside: [{ tool: "yield" }] }],
  ["yield, then a comment", { tool: "yield", alongside: [NOTE_CALL] }],
  [
    "a comment, yield, then a board read",
    { ...NOTE_CALL, alongside: [{ tool: "yield" }, { tool: "board" }] },
  ],
] as const) {
  test(`${place} in one block ends the turn silently and delivers the comment`, async () => {
    h.onModel(() => move, "mate");
    h.onModel(() => ({ text: "." }), "mate");
    const pane = await startMain(lab, scratch, h);
    await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");

    await cleo.call("comment", { lane: "cleo", text: "Validation is still running." });
    await settled();
    await takenIn("main", 1);
    await noteReaches();
    assert.equal(
      h.callsOf("mate").length,
      1,
      "the block must not ask the model for another message",
    );
    assert.deepEqual(await assistantText(), [""]);
    await keep(`3-batched-yield-${place.replaceAll(" ", "-")}`, pane);
  });
}

test("a card action that fails in the yield block still ends the turn silently and stays in the record", async () => {
  h.onModel(
    () => ({
      tool: "comment",
      args: { lane: "nobody", text: NOTE },
      alongside: [{ tool: "yield" }],
    }),
    "mate",
  );
  h.onModel(() => ({ text: OUTCOME }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");

  await cleo.call("comment", { lane: "cleo", text: "Validation is still running." });
  await settled();
  assert.equal(h.callsOf("mate").length, 1, "a failed sibling must not buy a chat message");
  assert.deepEqual(await assistantText(), [""]);

  await cleo.call("comment", { lane: "cleo", text: "The parser fix is ready for review." });
  await settled(2);
  const turns = await h.waitForCall(1, "mate");
  assert.ok(
    turns.some((turn) => turn.role === "toolResult" && /nobody/i.test(turn.text)),
    `the next turn never saw the failed comment: ${JSON.stringify(turns.slice(-4))}`,
  );
});

test("a tool that is not fleet's in the yield block still ends the turn silently", async () => {
  h.onModel(() => ({ tool: "slow_tool", alongside: [{ tool: "yield" }] }), "mate");
  h.onModel(() => ({ text: "." }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");

  await cleo.call("comment", { lane: "cleo", text: "Validation is still running." });
  await h.waitFor((event) => event["type"] === "tool_waiting", "the foreign tool");
  h.releaseTool();
  await settled();
  await takenIn("main", 1);
  assert.equal(h.callsOf("mate").length, 1, "the block must not ask the model for another message");
  assert.deepEqual(await assistantText(), [""]);
});

test("a message that arrives while the yield block runs starts a new turn after the silent end", async () => {
  h.onModel(() => ({ tool: "slow_tool", alongside: [{ tool: "yield" }] }), "mate");
  h.onModel(() => ({ text: OUTCOME }), "mate");
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");

  await cleo.call("comment", { lane: "cleo", text: "Validation is still running." });
  await h.waitFor((event) => event["type"] === "tool_waiting", "the first tool");
  await cleo.call("comment", { lane: "cleo", text: "The parser fix is ready for review." });
  await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the mid-block comment");
  h.releaseTool();
  await settled();
  await takenIn("main", 2);
  const turns = await h.waitForCall(1, "mate");
  assert.match(turns.at(-1)?.text ?? "", /The parser fix is ready for review/);
  assert.equal(h.callsOf("mate").length, 2);
  assert.deepEqual(await assistantText(), ["", OUTCOME]);
  await screenWith(pane, "Captain, the parser fix is ready for review:");
});

const script = (...steps: string[]): string =>
  steps.map((step) => `await tools.${step};`).join("\n");

test("a yield inside a codemode script ends the turn silently and delivers the comment", async () => {
  const code = script(`comment(${JSON.stringify({ lane: "cleo", text: NOTE })})`, "yield({})");
  h.onModel(() => ({ tool: "codemode", args: { code } }), "mate");
  h.onModel(() => ({ text: "." }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");

  await cleo.call("comment", { lane: "cleo", text: "Validation is still running." });
  await settled();
  await takenIn("main", 1);
  await noteReaches();
  assert.equal(h.callsOf("mate").length, 1, "a script that yields must not buy a chat message");
  assert.deepEqual(await assistantText(), [""]);
});

test("a message that arrives while a codemode script yields starts a new turn after the silent end", async () => {
  const code = script("slow_tool({})", "yield({})");
  h.onModel(() => ({ tool: "codemode", args: { code } }), "mate");
  h.onModel(() => ({ text: OUTCOME }), "mate");
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");

  await cleo.call("comment", { lane: "cleo", text: "Validation is still running." });
  await h.waitFor((event) => event["type"] === "tool_waiting", "the script's tool");
  await cleo.call("comment", { lane: "cleo", text: "The parser fix is ready for review." });
  await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the mid-script comment");
  h.releaseTool();
  await settled();
  await takenIn("main", 2);
  const turns = await h.waitForCall(1, "mate");
  assert.match(turns.at(-1)?.text ?? "", /The parser fix is ready for review/);
  assert.equal(h.callsOf("mate").length, 2);
  assert.deepEqual(await assistantText(), ["", OUTCOME]);
  await screenWith(pane, "Captain, the parser fix is ready for review:");
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
