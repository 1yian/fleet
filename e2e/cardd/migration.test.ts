// Opening a cards.db written before the worker cap was removed (migration 006),
// against a real cardd.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";

const MIGRATIONS = fileURLToPath(new URL("../../packages/cardd/migrations/", import.meta.url));

/** Writes a database as cardd left it before migration 006, with a project that has a capacity. */
function writeOldDatabase(file: string): void {
  const db = new DatabaseSync(file);
  const old = readdirSync(MIGRATIONS)
    .sort()
    .filter((name) => Number(name.slice(0, 3)) <= 5);
  for (const name of old) db.exec(readFileSync(`${MIGRATIONS}${name}`, "utf8"));
  db.exec("PRAGMA user_version = 5");
  db.exec(`INSERT INTO lanes (name, home) VALUES ('main', '/homes/main');
    INSERT INTO projects (name, delivery, clones, capacity)
      VALUES ('web', 'no-mistakes', '{"maverick":"/clones/web"}', 100)`);
  db.close();
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
