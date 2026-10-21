import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const MIGRATION_NAME = /^(\d{3})-[a-z0-9-]+\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export function readMigrations(): Migration[] {
  const names = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return names.map((name, index) => {
    const version = index + 1;
    const match = MIGRATION_NAME.exec(name);
    if (match?.[1] !== String(version).padStart(3, "0")) {
      throw new Error(`migration ${name}: expected ${String(version).padStart(3, "0")}-<name>.sql`);
    }
    return { version, name, sql: readFileSync(new URL(name, MIGRATIONS), "utf8") };
  });
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    const current = schemaVersion(db);
    const pending = readMigrations().filter((m) => m.version > current);
    for (const migration of pending) {
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new Error(`migration ${migration.name} failed: ${String(error)}`, { cause: error });
      }
      const broken = brokenKeys(db);
      if (broken.length > 0) {
        throw new Error(
          `foreign keys broken after migration ${migration.name}:\n${broken.join("\n")}`,
        );
      }
    }
    const last = pending.at(-1);
    if (last !== undefined) db.exec(`PRAGMA user_version = ${String(last.version)}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function brokenKeys(db: DatabaseSync): string[] {
  const keys = db
    .prepare(
      `SELECT DISTINCT c."table" AS child, k."from" AS col, k."table" AS parent, k."to" AS key
       FROM pragma_foreign_key_check() AS c
       JOIN pragma_foreign_key_list(c."table") AS k ON k.id = c.fkid`,
    )
    .all();
  return keys.flatMap(({ child, col, parent, key }) => {
    const q = (name: unknown): string => `"${String(name)}"`;
    const rows = db
      .prepare(
        `SELECT * FROM ${q(child)} WHERE ${q(col)} NOT IN (SELECT ${q(key)} FROM ${q(parent)})`,
      )
      .all();
    const where = `${String(child)}.${String(col)} -> ${String(parent)}.${String(key)}`;
    return rows.map((row) => `${where}: ${JSON.stringify(row)}`);
  });
}

export function schemaVersion(db: DatabaseSync): number {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (typeof version !== "number") throw new Error("PRAGMA user_version returned no number");
  return version;
}
