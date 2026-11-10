import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const MIGRATIONS = fileURLToPath(
  new URL("../../packages/cardd/migrations/", import.meta.url),
);

export function writeDatabaseAt(file: string, version: number): DatabaseSync {
  const db = new DatabaseSync(file);
  const old = readdirSync(MIGRATIONS)
    .sort()
    .filter((name) => Number(name.slice(0, 3)) <= version);
  for (const name of old) db.exec(readFileSync(`${MIGRATIONS}${name}`, "utf8"));
  db.exec(`PRAGMA user_version = ${String(version)}; PRAGMA foreign_keys = ON`);
  return db;
}
