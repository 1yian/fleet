import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { check, OPS, type Entry } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { writeDatabaseAt } from "../support/legacy-database.ts";

const T = 1_760_000_000_000;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const INCIDENT_KEY = createHash("sha256").update("incident-token-key").digest();
const incidentToken = (role: string, session: string): string =>
  createHmac("sha256", INCIDENT_KEY).update(`${role}:${session}`).digest("base64url");

let seededIncidents: Record<string, unknown>[] = [];

function writeIncidentDatabase(file: string): void {
  const db = writeDatabaseAt(file, 27);
  db.prepare("INSERT INTO secrets (name, value) VALUES ('token-key', ?)").run(INCIDENT_KEY);
  db.exec(`
    INSERT INTO lanes (name, home) VALUES ('main', '/homes/main');
    INSERT INTO lanes (name, home, parent) VALUES ('cleo', '/homes/cleo', 'main');
    INSERT INTO projects (name, delivery, clones)
      VALUES ('web', 'no-mistakes', '{"maverick":"/clones/web"}')
  `);
  const mate = db.prepare(
    "INSERT INTO sessions (id, role, lane, host, token_hash, state) VALUES (?, 'mate', ?, '', ?, 'idle')",
  );
  mate.run("main", "main", sha(incidentToken("mate", "main")));
  mate.run("cleo", "cleo", sha(incidentToken("mate", "cleo")));
  const card = db.prepare(
    `INSERT INTO cards (id, title, name, lane, project, kind, delivery, created_at)
     VALUES (?, ?, ?, 'cleo', 'web', 'ship', 'no-mistakes', ?)`,
  );
  const attempt = db.prepare(
    `INSERT INTO attempts (id, card, n, host, state, branch, created_at, updated_at)
     VALUES (?, ?, 1, 'maverick', ?, ?, ?, ?)`,
  );
  const worker = db.prepare(
    `INSERT INTO sessions (id, role, lane, attempt, host, token_hash, state)
     VALUES (?, 'worker', 'cleo', ?, 'maverick', ?, ?)`,
  );
  const task = db.prepare(
    `INSERT INTO entries (card, author, kind, body, fields, created_at)
     VALUES (?, 'mate:cleo', 'comment', ?, ?, ?)`,
  );
  for (const id of [1, 2, 3, 4]) {
    const name = `c-${String(id)}`;
    const ended = id === 3;
    card.run(id, `Card ${String(id)}`, name, T);
    attempt.run(id, id, ended ? "ended" : "active", `fm/${name}`, T, T);
    worker.run(
      `${name}-a1`,
      id,
      sha(incidentToken("worker", `${name}-a1`)),
      ended ? "closed" : "running",
    );
    if (!ended) task.run(id, `Do ${name}.`, JSON.stringify({ task: `Do ${name}.` }), T);
  }
  const past = Date.now() - 60_000;
  const insert = db.prepare(
    `INSERT INTO incidents (id, actor, card, parent, generation, phase, classification, error, source,
       intent, state, eligible_at, due_told, first_at, last_at, closed_at)
     VALUES (?, ?, ?, 'cleo', 0, 'turn', 'transient', '429 rate limit', 'turn', ?, ?, ?, 0, ?, ?, ?)`,
  );
  insert.run(1, "c-1-a1", 1, "merging", "open", past, T, T, null);
  insert.run(2, "c-2-a1", 2, "waiting", "open", past, T, T, null);
  insert.run(3, "c-3-a1", 3, "working", "verified", past, T, T, T + 5);
  insert.run(4, "c-4-a1", 4, "completed", "blocked", null, T, T, null);
  seededIncidents = db.prepare("SELECT * FROM incidents ORDER BY id").all();
  db.close();
}

async function polled<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const withoutDueTold = (rows: readonly Record<string, unknown>[]): unknown[] =>
  rows.map((row) => Object.entries(row).filter(([column]) => column !== "due_told"));

test("a fleet's live incidents survive the intent migration, and an old merging incident is still offered recovery", async () => {
  const cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.01" }, [], writeIncidentDatabase);
  try {
    const cleo = await cardd.connect(incidentToken("mate", "cleo"));
    const threadOf = async (card: number): Promise<Entry[]> =>
      check(OPS.card.result, await cleo.call("card", { card })).entries;
    const announced = await polled(
      async () =>
        (await threadOf(1)).find((entry) =>
          entry.body.includes("incident 1 is eligible for recovery now: restart_card"),
        ),
      "the recovery notice for the old merging incident",
    );
    assert.equal(announced.author, "check");

    const db = new DatabaseSync(cardd.db, { timeout: 5000 });
    try {
      const after = db.prepare("SELECT * FROM incidents WHERE id <= 4 ORDER BY id").all();
      assert.deepEqual(withoutDueTold(after), withoutDueTold(seededIncidents));
      assert.deepEqual(
        after.map(
          (row) =>
            `${String(row["id"])} ${String(row["state"])} ${String(row["intent"])} told=${String(row["due_told"])}`,
        ),
        [
          "1 open merging told=1",
          "2 open waiting told=1",
          "3 verified working told=0",
          "4 blocked completed told=0",
        ],
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO incidents (actor, card, generation, phase, classification, error, source,
                 intent, state, first_at, last_at)
               VALUES ('c-4-a1', 4, 0, 'turn', 'unknown', 'again', 'turn', 'working', 'open', 1, 1)`,
            )
            .run(),
        /UNIQUE constraint failed/,
      );
    } finally {
      db.close();
    }

    const quiet = (await threadOf(2)).filter((entry) =>
      entry.body.includes("eligible for recovery now"),
    );
    assert.deepEqual(quiet, []);
    const plan = check(
      OPS["card.restart"].result,
      await cleo.call("card.restart", {
        card: 1,
        incident: 1,
        generation: 0,
        mode: "retry",
        key: "legacy-merging",
      }),
    );
    assert.deepEqual([plan.incident, plan.card, plan.mode, plan.actor], [1, 1, "retry", "c-1-a1"]);
  } finally {
    await cardd.stop();
  }
});
