import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const MIGRATION_NAME = /^(\d{3})-[a-z0-9-]+\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Reads the migration files in order. Throws on a bad name or a gap in the numbers. */
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

/** Opens cards.db and applies each new migration in its own transaction. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const current = schemaVersion(db);
  for (const migration of readMigrations().filter((m) => m.version > current)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (typeof version !== "number") throw new Error("PRAGMA user_version returned no number");
  return version;
}
