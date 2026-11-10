import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { parseClientMessage, type Entry } from "@fleet/protocol";
import { WebSocketServer } from "ws";
import { startFleet, begin, newCard, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const T0 = Date.parse("2026-05-04T09:00:00Z");
const SECOND = 1000;
const BIG = "lorem ipsum dolor ".repeat(8000);
const COMPACTOR_DOWN =
  "pi-tiers: no usable model for tier 'default' (anthropic/claude-opus-5-5 on anthropic: cooling, openai/gpt-5 on openai: cooling)";
const COMPLETED = "reload completed - reconnected on a new process";
const QUIET_MS = 1_500;
const WAIT_MS = 30_000;

let fleet: Fleet | undefined;
let h: Harness | undefined;
let server: WebSocketServer | undefined;

afterEach(async () => {
  await h?.stop();
  await fleet?.cardd.stop();
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise((resolve) => {
    if (server === undefined) resolve(undefined);
    else server.close(resolve);
  });
  h = undefined;
  fleet = undefined;
  server = undefined;
});

function sessionOf(card: number): string {
  return `c-${String(card)}-a1`;
}

function readSession(session: string): { process: string | null; generation: number } {
  const db = new DatabaseSync(fleet?.cardd.db ?? "", { readOnly: true, timeout: 5000 });
  try {
    const row = db.prepare("SELECT process, generation FROM sessions WHERE id = ?").get(session);
    const process = row?.["process"];
    return {
      process: typeof process === "string" ? process : null,
      generation: Number(row?.["generation"] ?? 0),
    };
  } finally {
    db.close();
  }
}

function insertReloading(session: string, process: string): void {
  const db = new DatabaseSync(fleet?.cardd.db ?? "", { timeout: 5000 });
  try {
    db.prepare(
      `INSERT INTO maintenance (batch, requester, session, kind, state, process, detail, updated_at)
       VALUES (?, 'main', ?, 'reload', 'reloading', ?, 'waiting to reconnect', ?)`,
    ).run(`batch-${session}`, session, process, Date.now());
  } finally {
    db.close();
  }
}

function maintenanceState(session: string): string | undefined {
  const db = new DatabaseSync(fleet?.cardd.db ?? "", { readOnly: true, timeout: 5000 });
  try {
    const row = db.prepare("SELECT state FROM maintenance WHERE session = ?").get(session);
    const state = row?.["state"];
    return typeof state === "string" ? state : undefined;
  } finally {
    db.close();
  }
}

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

async function staysAt(read: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + QUIET_MS;
  for (;;) {
    assert.equal(read(), expected);
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("two processes on one token do not take the session from each other", async () => {
  fleet = await startFleet();
  h = await Harness.start();
  h.onModel(() => ({ text: "ok" }));
  const card = await newCard(fleet.main, "two processes");
  const token = await begin(fleet.main, card);
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  const first = h.startPi("a", env, [EXTENSION]);
  h.startPi("b", env, [EXTENSION]);
  const session = sessionOf(card.id);
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    2,
    "both processes to connect",
  );
  const connected = (): number =>
    h?.events.filter((event) => event["type"] === "fleet_connected").length ?? 0;
  first.prompt("ping");
  await staysAt(() => readSession(session).generation, 2);
  assert.equal(connected(), 2);
});

test("an in-process reload keeps the process and still completes a reload", async () => {
  fleet = await startFleet();
  h = await Harness.start();
  h.onModel(() => ({ text: "ok" }), "worker");
  const card = await newCard(fleet.main, "reload keeps the process");
  const token = await begin(fleet.main, card);
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    FLEET_FAKE_AGENT: "worker",
  };
  const worker = h.startPi(sessionOf(card.id), env, [EXTENSION]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, "the worker to connect");
  await h.waitForNth((event) => event["type"] === "settled", 1, "the opening turn to settle");
  const session = sessionOf(card.id);
  const before = readSession(session);
  assert.equal(before.generation, 1);
  assert.notEqual(before.process, null);
  insertReloading(session, before.process ?? "");
  worker.prompt("/probe-reload");
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes(COMPLETED),
    "the reload to complete",
  );
  const after = readSession(session);
  assert.equal(after.generation, before.generation);
  assert.equal(after.process, before.process);
  assert.equal(maintenanceState(session), "completed");
});

test("a reconnect of the same process does not complete a reload", async () => {
  fleet = await startFleet();
  h = await Harness.start();
  h.onModel(() => ({ text: "ok" }), "worker");
  const card = await newCard(fleet.main, "reconnect keeps the reload open");
  const token = await begin(fleet.main, card);
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    FLEET_FAKE_AGENT: "worker",
  };
  h.startPi(sessionOf(card.id), env, [EXTENSION]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, "the worker to connect");
  const session = sessionOf(card.id);
  const before = readSession(session);
  insertReloading(session, before.process ?? "");
  await fleet.cardd.restart();
  await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "the worker to reconnect");
  assert.equal(maintenanceState(session), "reloading");
  assert.equal(readSession(session).generation, before.generation);
});

test("an in-process reload keeps the compaction backoff", async () => {
  const clockFile = join(tempDir("fleet-clock-"), "clock");
  const setClock = (ms: number): void => {
    const next = `${clockFile}.next`;
    writeFileSync(next, new Date(ms).toISOString());
    renameSync(next, clockFile);
  };
  setClock(T0);
  fleet = await startFleet();
  h = await Harness.start();
  for (let call = 0; call < 80; call += 1)
    h.onModel((seen) => {
      if (!seen.some((turn) => turn.text.includes("ONLY output the structured summary")))
        return { text: "ok" };
      return { fail: COMPACTOR_DOWN };
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
  let turns = 0;
  const attempts = (): number =>
    h
      ?.callsOf("cleo")
      .filter((seen) =>
        seen.some((turn) => turn.text.includes("ONLY output the structured summary")),
      ).length ?? 0;
  const turn = async (): Promise<void> => {
    turns += 1;
    cleo.prompt(`${BIG}${String(turns)}`);
    await h?.waitForNth((event) => event["type"] === "settled", turns, "the turn to settle");
  };
  const attemptsAfterTurn = async (): Promise<number> => {
    await turn();
    return attempts();
  };
  let seen = await attemptsAfterTurn();
  while (seen === 0) seen = await attemptsAfterTurn();
  const first = seen;
  assert.equal(await attemptsAfterTurn(), first, "a retry came with no wait");
  cleo.prompt("/probe-reload");
  await h.waitFor(
    (event) => event["type"] === "session" && event["reason"] === "reload",
    "the extension to reload",
  );
  setClock(T0 + 31 * SECOND);
  const retried = await attemptsAfterTurn();
  assert.equal(retried, first + 1, "no retry after the first backoff expired");
  assert.equal(await attemptsAfterTurn(), retried, "the reload cleared the backoff");
});

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
  for (let call = 0; call < 80; call += 1)
    h.onModel((seen) => {
      if (!seen.some((turn) => turn.text.includes("ONLY output the structured summary")))
        return { text: "ok" };
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
  while (!attempted()) await turn();
  await fleet.main.waitForEntry(isFailure, "the compaction failure");
  await untilIncidents(["open"]);
  return {
    cleo,
    setClock,
    turn,
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

test("a start announcement survives a hello that cardd never accepted", async () => {
  h = await Harness.start();
  const hellos: boolean[] = [];
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      if (!Buffer.isBuffer(data)) return;
      const message = parseClientMessage(data.toString("utf8"));
      if (message.t !== "hello") return;
      hellos.push(message.started === true);
      if (hellos.length === 1) {
        socket.close(1011, "cardd went away before it answered");
        return;
      }
      socket.send(JSON.stringify({ t: "welcome", session: "cleo", role: "mate", lowWater: 0 }));
      if (hellos.length === 2) socket.close(1012, "cardd restarted");
    });
  });
  await new Promise((resolve) => server?.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  h.startPi(
    "cleo",
    {
      FLEET_URL: `ws://127.0.0.1:${String(port)}/session`,
      FLEET_TOKEN: "any-token",
      FLEET_ROLE: "mate",
    },
    [EXTENSION],
  );
  const deadline = Date.now() + WAIT_MS;
  while (hellos.length < 3) {
    if (Date.now() > deadline) assert.fail("timed out waiting for three hellos");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(hellos.slice(0, 3), [true, true, false]);
});
