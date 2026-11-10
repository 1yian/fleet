import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const T0 = Date.parse("2026-05-04T09:00:00Z");
const SECOND = 1000;
const BIG = "lorem ipsum dolor ".repeat(8000);
const COMPACTOR_DOWN =
  "pi-tiers: no usable model for tier 'default' (anthropic/claude-opus-5-5 on anthropic: cooling, openai/gpt-5 on openai: cooling)";
const TURN_DOWN = "provider exploded: code 44";
const WAIT_MS = 30_000;

let fleet: Fleet | undefined;
let h: Harness | undefined;

afterEach(async () => {
  await h?.stop();
  await fleet?.cardd.stop();
  h = undefined;
  fleet = undefined;
});

function incidentStates(): string[] {
  const db = new DatabaseSync(fleet?.cardd.db ?? "", { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare("SELECT state FROM incidents ORDER BY id")
      .all()
      .map((row) => (typeof row["state"] === "string" ? row["state"] : ""));
  } finally {
    db.close();
  }
}

async function untilIncidents(expected: string[]): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = incidentStates();
    if (found.join() === expected.join()) return;
    if (Date.now() > deadline) assert.deepEqual(found, expected);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";

async function reloaded(cleo: Pi, connections: number): Promise<void> {
  cleo.prompt("/probe-reload");
  await h?.waitFor(
    (event) => event["type"] === "session" && event["reason"] === "reload",
    "the extension to reload",
  );
  await h?.waitForNth(
    (event) => event["type"] === "fleet_connected",
    connections,
    "the extension to connect again",
  );
}

test("an in-process reload does not keep a recovered turn failure open", async () => {
  fleet = await startFleet();
  h = await Harness.start();
  h.onModel(() => ({ fail: "provider exploded: code 42" }), "cleo");
  h.onModel(() => ({ text: "ok" }), "cleo");
  h.onModel(() => ({ fail: "provider exploded: code 43" }), "cleo");
  const token = fleet.cardd.addLane("cleo", "main");
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "mate",
    FLEET_FAKE_AGENT: "cleo",
  };
  const cleo = h.startPi("cleo", env, [EXTENSION]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, "cleo to connect");
  cleo.prompt("first");
  const first = await fleet.main.waitForEntry(isFailure, "the first failure");
  await untilIncidents(["open"]);
  await reloaded(cleo, 2);
  cleo.prompt("second");
  await untilIncidents(["cleared"]);
  cleo.prompt("third");
  await fleet.main.waitForEntry(
    (entry) => isFailure(entry) && entry.id !== first.id,
    "the failure after the recovery to open a new incident",
  );
  await untilIncidents(["cleared", "open"]);
});

interface CompactingCleo {
  readonly cleo: Pi;
  readonly setClock: (ms: number) => void;
  readonly turn: () => Promise<void>;
  readonly failingTurn: () => Promise<void>;
  readonly compactorUp: () => void;
}

async function startCompactingCleo(): Promise<CompactingCleo> {
  const clockFile = join(tempDir("fleet-clock-"), "clock");
  const setClock = (ms: number): void => {
    const next = `${clockFile}.next`;
    writeFileSync(next, new Date(ms).toISOString());
    renameSync(next, clockFile);
  };
  setClock(T0);
  fleet = await startFleet();
  h = await Harness.start();
  let up = false;
  let failing = false;
  for (let call = 0; call < 80; call += 1)
    h.onModel((seen) => {
      if (!seen.some((turn) => turn.text.includes("ONLY output the structured summary")))
        return failing ? { fail: TURN_DOWN } : { text: "ok" };
      return up ? { text: "a summary" } : { fail: COMPACTOR_DOWN };
    }, "cleo");
  const token = fleet.cardd.addLane("cleo", "main");
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "mate",
    FLEET_FAKE_AGENT: "cleo",
    FLEET_CLOCK_FILE: clockFile,
  };
  const cleo: Pi = h.startPi("cleo", env, [EXTENSION]);
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, "cleo to connect");
  let turns = 0;
  const attempted = (): boolean =>
    h
      ?.callsOf("cleo")
      .some((seen) =>
        seen.some((each) => each.text.includes("ONLY output the structured summary")),
      ) === true;
  const turn = async (): Promise<void> => {
    turns += 1;
    cleo.prompt(`${BIG}${String(turns)}`);
    await h?.waitForNth((event) => event["type"] === "settled", turns, "the turn to settle");
  };
  const failingTurn = async (): Promise<void> => {
    failing = true;
    turns += 1;
    cleo.prompt("one more");
    await h?.waitForNth((event) => event["type"] === "settled", turns, "the turn to settle");
  };
  while (!attempted()) await turn();
  await fleet.main.waitForEntry(isFailure, "the compaction failure");
  await untilIncidents(["open"]);
  return {
    cleo,
    setClock,
    turn,
    failingTurn,
    compactorUp: () => {
      up = true;
    },
  };
}

test("an in-process reload does not keep a recovered compaction failure open", async () => {
  const { cleo, setClock, turn, compactorUp } = await startCompactingCleo();
  await reloaded(cleo, 2);
  compactorUp();
  setClock(T0 + 31 * SECOND);
  await turn();
  await untilIncidents(["cleared"]);
});

test("a turn that recovers while cardd is unreachable closes its incident at the next connect", async () => {
  fleet = await startFleet();
  h = await Harness.start();
  h.onModel(() => ({ fail: "provider exploded: code 42" }), "cleo");
  h.onModel(() => ({ text: "ok" }), "cleo");
  h.onModel(() => ({ fail: "provider exploded: code 43" }), "cleo");
  const token = fleet.cardd.addLane("cleo", "main");
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "mate",
    FLEET_FAKE_AGENT: "cleo",
  };
  const cleo = h.startPi("cleo", env, [EXTENSION]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, "cleo to connect");
  cleo.prompt("first");
  const first = await fleet.main.waitForEntry(isFailure, "the first failure");
  await untilIncidents(["open"]);
  await fleet.cardd.stop();
  cleo.prompt("second");
  await h.waitForNth((event) => event["type"] === "settled", 2, "the turn to settle");
  await fleet.cardd.restart();
  await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "cleo to reconnect");
  await untilIncidents(["cleared"]);
  const main = await fleet.cardd.connect(fleet.mainToken);
  cleo.prompt("third");
  await main.waitForEntry(
    (entry) => isFailure(entry) && entry.id !== first.id,
    "the failure after the recovery to open a new incident",
  );
  await untilIncidents(["cleared", "open"]);
});

test("a compaction that recovers while cardd is unreachable closes its incident at the next connect", async () => {
  const { setClock, turn, compactorUp } = await startCompactingCleo();
  await fleet?.cardd.stop();
  compactorUp();
  setClock(T0 + 31 * SECOND);
  await turn();
  await h?.waitFor((event) => event["type"] === "compacted", "the compaction to succeed");
  await fleet?.cardd.restart();
  await h?.waitForNth((event) => event["type"] === "fleet_connected", 2, "cleo to reconnect");
  await untilIncidents(["cleared"]);
});

test("a recovery and a later failure that cardd never heard survive a reload and reach it in order", async () => {
  fleet = await startFleet();
  h = await Harness.start();
  h.onModel(() => ({ fail: "provider exploded: code 42" }), "cleo");
  h.onModel(() => ({ text: "ok" }), "cleo");
  h.onModel(() => ({ fail: "provider exploded: code 43" }), "cleo");
  const token = fleet.cardd.addLane("cleo", "main");
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "mate",
    FLEET_FAKE_AGENT: "cleo",
  };
  const cleo = h.startPi("cleo", env, [EXTENSION]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, "cleo to connect");
  cleo.prompt("first");
  const first = await fleet.main.waitForEntry(isFailure, "the first failure");
  await untilIncidents(["open"]);
  await fleet.cardd.stop();
  cleo.prompt("second");
  await h.waitForNth((event) => event["type"] === "settled", 2, "the recovery to settle");
  cleo.prompt("third");
  await h.waitForNth((event) => event["type"] === "settled", 3, "the next failure to settle");
  cleo.prompt("/probe-reload");
  await h.waitFor(
    (event) => event["type"] === "session" && event["reason"] === "reload",
    "the extension to reload",
  );
  await fleet.cardd.restart();
  await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "cleo to reconnect");
  await untilIncidents(["cleared", "open"]);
  const main = await fleet.cardd.connect(fleet.mainToken);
  await main.waitForEntry(
    (entry) => isFailure(entry) && entry.id !== first.id,
    "the failure after the recovery to open a new incident",
  );
});

test("a compaction that recovers while cardd is unreachable closes its incident after a reload", async () => {
  const { cleo, setClock, turn, compactorUp } = await startCompactingCleo();
  await fleet?.cardd.stop();
  compactorUp();
  setClock(T0 + 31 * SECOND);
  await turn();
  await h?.waitFor((event) => event["type"] === "compacted", "the compaction to succeed");
  cleo.prompt("/probe-reload");
  await h?.waitFor(
    (event) => event["type"] === "session" && event["reason"] === "reload",
    "the extension to reload",
  );
  await fleet?.cardd.restart();
  await h?.waitForNth((event) => event["type"] === "fleet_connected", 2, "cleo to reconnect");
  await untilIncidents(["cleared"]);
});

test("a recovered compaction and a later failed turn that cardd never heard are told in that order", async () => {
  const { setClock, turn, failingTurn, compactorUp } = await startCompactingCleo();
  await fleet?.cardd.stop();
  compactorUp();
  setClock(T0 + 31 * SECOND);
  await turn();
  await h?.waitFor((event) => event["type"] === "compacted", "the compaction to succeed");
  await failingTurn();
  await fleet?.cardd.restart();
  await h?.waitForNth((event) => event["type"] === "fleet_connected", 2, "cleo to reconnect");
  await untilIncidents(["cleared", "open"]);
  const main = await fleet?.cardd.connect(fleet.mainToken);
  await main?.waitForEntry(
    (entry) => isFailure(entry) && entry.body.includes(TURN_DOWN),
    "the failed turn to open its own incident",
  );
});
