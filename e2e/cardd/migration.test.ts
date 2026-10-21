import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";

const MIGRATIONS = fileURLToPath(new URL("../../packages/cardd/migrations/", import.meta.url));
const MAIN = fileURLToPath(new URL("../../packages/cardd/src/main.ts", import.meta.url));

function writeDatabaseAt(file: string, version: number): DatabaseSync {
  const db = new DatabaseSync(file);
  const old = readdirSync(MIGRATIONS)
    .sort()
    .filter((name) => Number(name.slice(0, 3)) <= version);
  for (const name of old) db.exec(readFileSync(`${MIGRATIONS}${name}`, "utf8"));
  db.exec(`PRAGMA user_version = ${String(version)}; PRAGMA foreign_keys = ON`);
  return db;
}

function writeOldDatabase(file: string): void {
  const db = writeDatabaseAt(file, 5);
  db.exec(`INSERT INTO lanes (name, home) VALUES ('main', '/homes/main');
    INSERT INTO projects (name, delivery, clones, capacity)
      VALUES ('web', 'no-mistakes', '{"maverick":"/clones/web"}', 100)`);
  db.close();
}

const T = 1_760_000_000_000;

function writeLiveShapedDatabase(file: string): void {
  const db = writeDatabaseAt(file, 4);
  db.exec(`
    INSERT INTO lanes (name, home) VALUES ('main', '/homes/main');
    INSERT INTO lanes (name, home, parent) VALUES ('cleo', '/homes/cleo', 'main');
    INSERT INTO projects (name, delivery, clones, capacity)
      VALUES ('web', 'no-mistakes', '{"maverick":"/clones/web"}', 2);

    INSERT INTO cards (id, title, name, lane, project, kind, status, delivery, created_at, updated_at) VALUES
      (1, 'Ship the listing', 'c-1', 'cleo', 'web', 'ship', 'done', 'no-mistakes', 1760000000000, 1760000000000),
      (2, 'Submit the app', 'c-2', 'cleo', 'web', 'ship', 'needs-you', 'no-mistakes', 1760000000000, 1760000000000),
      (3, 'Pick a store name', 'c-3', 'main', NULL, 'captain', 'dropped', NULL, 1760000000000, 1760000000000),
      (4, 'Retry the flaky build', 'c-4', 'cleo', 'web', 'ship', 'dropped', 'no-mistakes', 1760000000000, 1760000000000),
      (5, 'Rotate the key', 'c-5', 'cleo', 'web', 'ship', 'with-first-mate', 'no-mistakes', 1760000000000, 1760000000000);
    INSERT INTO cards (id, title, name, lane, project, kind, status, delivery, held_until,
        return_status, created_at, updated_at)
      VALUES (6, 'Renew the domain', 'c-6', 'cleo', 'web', 'ship', 'waiting', 'no-mistakes',
        1760086400000, 'working', 1760000000000, 1760000000000);

    INSERT INTO attempts (id, card, n, host, state, worktree, branch, created_at, updated_at)
      VALUES (1, 1, 1, 'maverick', 'ended', '/clones/web.worktrees/c-1-a1', 'fm/c-1', 1760000000000, 1760000000000);
    INSERT INTO sessions (id, role, lane, attempt, host, token_hash, state) VALUES
      ('s-main', 'mate', 'main', NULL, 'maverick', 'h-main', 'idle'),
      ('s-cleo', 'mate', 'cleo', NULL, 'maverick', 'h-cleo', 'running'),
      ('s-c1', 'worker', 'cleo', 1, 'maverick', 'h-c1', 'closed');
    INSERT INTO jobs (id, attempt, label, command, state, exit_code, created_at, updated_at)
      VALUES (1, 1, 'tests', 'npm test', 'finished', 0, 1760000000000, 1760000000000);

    INSERT INTO entries (id, card, author, kind, body, fields, created_at) VALUES
      (1, 1, 'mate:cleo', 'comment', 'Ship the listing.', '{"task":"Ship the listing."}', 1760000000000),
      (2, 1, 'worker:c-1-a1', 'report', 'Tests pass.', '{"status":"working","statusAfter":"working"}', 1760000000000 + 1),
      (3, 1, 'job:1', 'job-result', 'ok', '{"job":1,"label":"tests","exitCode":0}', 1760000000000 + 2),
      (4, 1, 'worker:c-1-a1', 'ask', 'Merge it?', '{"options":["Merge","Hold"],"merge":true,"pr":"https://github.com/acme/web/pull/1"}', 1760000000000 + 3),
      (5, 1, 'mate:main', 'answer', 'Merge', '{"resolves":"4","source":"chat","by":"mate:main","choice":"Merge"}', 1760000000000 + 4),
      (6, 1, 'fleet', 'merge', 'Merged.', '{"pr":"https://github.com/acme/web/pull/1","outcome":"merged"}', 1760000000000 + 5),
      (7, 1, 'fleet', 'cleanup', 'Cleaned up.', '{"outcome":"clean","archives":[],"left":[]}', 1760000000000 + 6),
      (8, 2, 'mate:cleo', 'ask', 'Which account should review the app?', '{"options":["A: a demo account","B: none"]}', 1760000000000 + 7),
      (9, 3, 'mate:main', 'ask', 'Which name?', '{"options":["Cleo","Leo"]}', 1760000000000 + 8),
      (10, 3, 'captain', 'answer', 'Neither', '{"resolves":"9","source":"board"}', 1760000000000 + 9),
      (11, 4, 'check', 'finding', 'The build failed twice.', '{"condition":"build-failed"}', 1760000000000 + 10),
      (12, 5, 'mate:cleo', 'ask', 'Rotate now?', '{"options":["Now","Later"]}', 1760000000000 + 11),
      (13, 2, 'captain', 'grant', 'Merge on green.', '{"grant":1,"merge":true}', 1760000000000 + 12),
      (14, 2, 'mate:main', 'note', 'Forwarded from cleo.', '{"routed":"cleo"}', 1760000000000 + 13),
      (15, 6, 'worker:c-6-a1', 'report', 'Back tomorrow.', '{"status":"waiting","until":1760086400000,"statusAfter":"waiting"}', 1760000000000 + 14);

    INSERT INTO findings (id, card, condition, entry, opened_at, cleared_at)
      VALUES (1, 4, 'build-failed', 11, 1760000000000 + 10, 1760000000000 + 11);
    INSERT INTO grants (id, card, words, source_entry, may, created_at)
      VALUES (1, 2, 'Merge on green.', 13, 'merge', 1760000000000 + 12);
    INSERT INTO deliveries (session, entry, state, updated_at)
      SELECT CASE WHEN card = 3 THEN 's-main' ELSE 's-cleo' END, id,
        CASE id % 3 WHEN 0 THEN 'pushed' WHEN 1 THEN 'acknowledged' ELSE 'confirmed' END, created_at
      FROM entries;
    INSERT INTO deliveries (session, entry, state, updated_at)
      SELECT 's-c1', id, 'confirmed', created_at FROM entries WHERE card = 1;
  `);
  db.close();
}

function contents(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")
    .all();
  const rows = tables
    .filter((table) => String(table["sql"]).startsWith("CREATE TABLE"))
    .map((table) => db.prepare(`SELECT * FROM "${String(table["name"])}"`).all());
  const version = db.prepare("PRAGMA user_version").get();
  db.close();
  return JSON.stringify({ version, tables, rows });
}

test("a database with a project capacity opens, keeps its project, and dispatches past the old cap", async () => {
  const cardd = await Cardd.start({}, [], writeOldDatabase);
  try {
    const columns = new DatabaseSync(cardd.db, { readOnly: true })
      .prepare("SELECT name FROM pragma_table_info('projects')")
      .all()
      .map((row) => String(row["name"]));
    assert.ok(!columns.includes("capacity"), columns.join(","));

    const main = await cardd.connect(cardd.addLane("cleo", "main"));
    for (const title of ["one", "two", "three", "four"]) {
      const card = check(
        CardSchema,
        await main.call("card.new", { title, kind: "ship", project: "web" }),
      );
      const begun = check(
        OPS["attempt.begin"].result,
        await main.call("attempt.begin", { card: card.id, host: "maverick", task: title }),
      );
      assert.equal(begun.clone, "/clones/web");
    }
  } finally {
    await cardd.stop();
  }
});

test("the live fleet's database from before holds opens with every entry, delivery, and open ask", async () => {
  const cardd = await Cardd.start({}, [], writeLiveShapedDatabase);
  try {
    const board = await cardd.board();
    assert.deepEqual(
      board.holds.map(({ card, hold, question, options }) => ({ card, hold, question, options })),
      [
        {
          card: 2,
          hold: 8,
          question: "Which account should review the app?",
          options: ["A: a demo account", "B: none"],
        },
        { card: 5, hold: 12, question: "Rotate now?", options: ["Now", "Later"] },
      ],
    );
    assert.deepEqual(
      board.cards.map(({ id, kind, status }) => `${String(id)} ${kind} ${status}`),
      [
        "1 ship done",
        "2 ship needs-you",
        "3 captain dropped",
        "4 ship dropped",
        "5 ship needs-you",
        "6 ship waiting",
        "7 standing waiting",
      ],
    );

    const merged = await cardd.thread(1);
    assert.deepEqual(
      merged.entries.map(({ id, kind, author }) => `${String(id)} ${kind} ${author}`),
      [
        "1 comment mate:cleo",
        "2 report worker:c-1-a1",
        "4 hold worker:c-1-a1",
        "5 answer mate:main",
        "6 merge fleet",
        "7 cleanup fleet",
      ],
    );
    assert.deepEqual(merged.entries.find(({ id }) => id === 4)?.fields, {
      options: ["Merge", "Hold"],
      merge: true,
      pr: "https://github.com/acme/web/pull/1",
    });
    const held = (await cardd.thread(6)).entries.map(({ kind, fields }) => ({ kind, fields }));
    assert.deepEqual(held.at(-1), {
      kind: "hold",
      fields: { holder: "owner", until: T + 86_400_000 },
    });

    const db = new DatabaseSync(cardd.db, { readOnly: true });
    const count = (sql: string): unknown => db.prepare(sql).get()?.["n"];
    assert.equal(
      count("SELECT group_concat(id || ' ' || kind, ', ') AS n FROM entries WHERE id <= 15"),
      "1 comment, 2 report, 3 job-result, 4 hold, 5 answer, 6 merge, 7 cleanup, 8 hold, " +
        "9 hold, 10 answer, 11 finding, 12 hold, 13 grant, 14 note, 15 report",
    );
    assert.equal(count("SELECT count(*) AS n FROM deliveries"), 22);
    assert.equal(count("SELECT entry AS n FROM findings WHERE id = 1"), 11);
    assert.equal(count("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'grants'"), 0);
    assert.equal(count("SELECT group_concat(name || ' ' || yolo) AS n FROM projects"), "web 0");
    assert.equal(count("SELECT user_version AS n FROM pragma_user_version"), 8);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  } finally {
    await cardd.stop();
  }
});

function writeGrantsDatabase(file: string): void {
  const db = writeDatabaseAt(file, 7);
  db.exec(`
    INSERT INTO lanes (name, home) VALUES ('main', '/homes/main');
    INSERT INTO lanes (name, home, parent) VALUES ('leo', '/homes/leo', 'main');
    INSERT INTO projects (name, delivery) VALUES ('dotfiles', 'direct-PR'), ('leo', 'direct-PR'),
      ('fleet', 'direct-PR'), ('cleo', 'direct-PR'), ('old', 'direct-PR'), ('gone', 'direct-PR'),
      ('branchy', 'direct-PR'), ('asks', 'direct-PR');
    INSERT INTO cards (id, title, name, lane, project, kind, status, phase, created_at, updated_at)
      VALUES (1, 'Merge Leo', 'merge-leo', 'leo', 'cleo', 'ship', 'working', 'working', ${String(T)}, ${String(T)});
    INSERT INTO grants (lane, card, words, may, merge, scope_project, scope_branch, expires, ended_at, created_at) VALUES
      ('main', NULL, 'Firstmate registry: dotfiles [direct-PR +yolo]', 'merge when CI is green', 1, 'dotfiles', NULL, NULL, NULL, ${String(T)}),
      ('leo', NULL, 'Firstmate registry: leo [direct-PR +yolo]', 'merge when CI is green', 1, 'leo', NULL, NULL, NULL, ${String(T)}),
      ('main', NULL, 'from now auto merge stuff for fleet', 'merge fleet PRs', 1, 'fleet', NULL, NULL, NULL, ${String(T)}),
      (NULL, 1, 'merge it if green', 'merge the PR', 1, NULL, NULL, NULL, NULL, ${String(T)}),
      ('main', NULL, 'merge old this week', 'merge', 1, 'old', NULL, ${String(T)}, NULL, ${String(T)}),
      ('main', NULL, 'merge gone', 'merge', 1, 'gone', NULL, NULL, ${String(T)}, ${String(T)}),
      ('main', NULL, 'merge branchy to main', 'merge', 1, 'branchy', 'main', NULL, NULL, ${String(T)}),
      ('main', NULL, 'you may fix asks', 'fix', 0, 'asks', NULL, NULL, NULL, ${String(T)}),
      ('main', NULL, 'merge anything', 'merge', 1, NULL, NULL, NULL, NULL, ${String(T)});
  `);
  db.close();
}

test("the live fleet's merge grants become each project's yolo flag, and no other grant carries over", async () => {
  const cardd = await Cardd.start({}, [], writeGrantsDatabase);
  try {
    const main = await cardd.connect(cardd.addLane("other", "main"));
    const projects = check(OPS.projects.result, await main.call("projects", {}));
    assert.deepEqual(
      projects.map(({ name, yolo }) => `${name} ${yolo ? "on" : "off"}`),
      [
        "asks off",
        "branchy off",
        "cleo off",
        "dotfiles on",
        "fleet on",
        "gone off",
        "leo on",
        "old off",
      ],
    );
  } finally {
    await cardd.stop();
  }
});

test("a migration that meets a broken foreign key names the row and leaves the database as it was", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fleet-cardd-")), "cards.db");
  writeLiveShapedDatabase(file);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO entries (id, card, author, kind, body, created_at)
      VALUES (16, 99, 'mate:cleo', 'comment', 'On a card that is gone.', 1760000000000 + 15)`);
  db.close();
  const before = contents(file);

  const run = spawnSync("node", [MAIN, "serve", "--db", file, "--listen", "127.0.0.1:0"], {
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /foreign keys broken after migration 005-lane-card\.sql:\nentries\.card -> cards\.id: \{"id":16,"card":99,/,
  );
  assert.equal(contents(file), before);
});
