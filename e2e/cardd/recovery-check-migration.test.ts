import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import type { Fleet } from "../support/fleet.ts";
import { writeDatabaseAt } from "../support/legacy-database.ts";
import { missedAbout, untakenControl } from "../support/missed.ts";

const T = 1_760_000_000_000;
const KEY = createHash("sha256").update("recovery-check-token-key").digest();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const tokenOf = (role: string, session: string): string =>
  createHmac("sha256", KEY).update(`${role}:${session}`).digest("base64url");

function stuckChecks(file: string): void {
  const db = writeDatabaseAt(file, 36);
  db.prepare("INSERT INTO secrets (name, value) VALUES ('token-key', ?)").run(KEY);
  db.exec(`
    INSERT INTO lanes (name, home) VALUES ('main', '/homes/main');
    INSERT INTO projects (name, delivery, clones)
      VALUES ('web', 'no-mistakes', '{"maverick":"/clones/web"}')
  `);
  db.prepare(
    "INSERT INTO sessions (id, role, lane, host, token_hash, state) VALUES ('main', 'mate', 'main', '', ?, 'idle')",
  ).run(sha(tokenOf("mate", "main")));
  const card = db.prepare(
    `INSERT INTO cards (id, title, name, lane, project, kind, delivery, created_at)
     VALUES (?, ?, ?, 'main', 'web', 'ship', 'no-mistakes', ?)`,
  );
  const attempt = db.prepare(
    `INSERT INTO attempts (id, card, n, host, state, branch, created_at, updated_at)
     VALUES (?, ?, 1, 'maverick', 'active', ?, ?, ?)`,
  );
  const worker = db.prepare(
    `INSERT INTO sessions (id, role, lane, attempt, host, token_hash, state)
     VALUES (?, 'worker', 'main', ?, 'maverick', ?, 'idle')`,
  );
  const entry = db.prepare(
    "INSERT INTO entries (id, card, author, kind, body, fields, created_at) VALUES (?, ?, 'mate:main', 'comment', ?, ?, ?)",
  );
  const delivery = db.prepare(
    `INSERT INTO deliveries (session, entry, state, updated_at, resends)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const incident = db.prepare(
    `INSERT INTO incidents (id, actor, card, parent, generation, phase, classification, error, source,
       intent, state, recovery_key, recovery_mode, recovery_entry, recovery_deadline, first_at, last_at,
       closed_at)
     VALUES (?, ?, ?, 'main', 0, ?, 'unknown', 'provider exploded', 'turn', 'working', ?, 'retry', 'retry', ?, ?, ?, ?, ?)`,
  );
  const past = Date.now() - 600_000;
  const check = (incidentId: number, compaction: boolean): string =>
    JSON.stringify({ for: "worker", recovery: incidentId, ...(compaction ? { compaction } : {}) });
  const states: [number, string, string, boolean][] = [
    [1, "verified", "pushed-again", true],
    [2, "cleared", "read", false],
    [3, "recovering", "pushed", false],
  ];
  for (const [id, state, delivered, compaction] of states) {
    const name = `c-${String(id)}`;
    card.run(id, `Card ${String(id)}`, name, T);
    attempt.run(id, id, `fm/${name}`, T, T);
    worker.run(`${name}-a1`, id, sha(tokenOf("worker", `${name}-a1`)));
    entry.run(id * 10, id, `Do ${name}.`, JSON.stringify({ task: `Do ${name}.` }), T);
    delivery.run(`${name}-a1`, id * 10, "confirmed", past, 0);
    entry.run(id * 10 + 1, id, `recovery check ${String(id)} from main`, check(id, compaction), T);
    delivery.run(`${name}-a1`, id * 10 + 1, delivered, past, 2);
    if (state !== "recovering") {
      db.prepare(
        "INSERT INTO entries (id, card, author, kind, body, fields, created_at) VALUES (?, ?, 'check', 'finding', ?, ?, ?)",
      ).run(
        id * 10 + 5,
        id,
        `missed: the worker on ${name} did not take in this comment from mate:main, re-sent 9 times`,
        JSON.stringify({ condition: "missed", entry: id * 10 + 1, worker: `${name}-a1` }),
        T,
      );
      delivery.run("main", id * 10 + 5, "pushed", past, 0);
    }
    incident.run(
      id,
      `${name}-a1`,
      id,
      compaction ? "compaction" : "turn",
      state,
      id * 10 + 1,
      state === "recovering" ? Date.now() + 600_000 : null,
      T,
      T,
      state === "recovering" ? null : T + 5,
    );
  }
  db.close();
}

test("a recovery check whose incident already ended is not delivered or reported missed after the upgrade, and one still recovering is", async () => {
  const cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.02" }, [], stuckChecks);
  const mainToken = tokenOf("mate", "main");
  const fleet: Fleet = { cardd, mainToken, main: await cardd.connect(mainToken) };
  try {
    const verified = await cardd.connect(tokenOf("worker", "c-1-a1"), [], false);
    const cleared = await cardd.connect(tokenOf("worker", "c-2-a1"), [], false);
    const recovering = await cardd.connect(tokenOf("worker", "c-3-a1"), [], false);
    const control = await untakenControl(fleet, "A task nobody takes in");
    await control.reportedMissed();

    const checks = (worker: typeof verified): string[] =>
      worker.entries
        .filter((push) => push.entry.fields["recovery"] !== undefined)
        .map((push) => push.entry.body);
    assert.deepEqual(checks(verified), []);
    assert.deepEqual(checks(cleared), []);
    assert.deepEqual(checks(recovering), ["recovery check 3 from main"]);
    assert.deepEqual(
      [1, 2].flatMap((card) => missedAbout(fleet, card)),
      [],
    );
    await Promise.all([verified, cleared, recovering, control.worker].map((each) => each.close()));
  } finally {
    await cardd.stop();
  }
});
