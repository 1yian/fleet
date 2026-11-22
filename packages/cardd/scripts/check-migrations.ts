import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { openDatabase, readMigrations, schemaVersion } from "../src/db.ts";

const SCHEMA_FILE = new URL("../schema.sql", import.meta.url);
const MIGRATIONS_DIR = "packages/cardd/migrations";
const PLACED_HOST_041 = `${MIGRATIONS_DIR}/041-placed-host.sql`;
const SIGNIN_GRANTS_041 = `${MIGRATIONS_DIR}/041-signin-grants.sql`;
const SIGNIN_GRANTS_RENAME = `R100\t${SIGNIN_GRANTS_041}\t${MIGRATIONS_DIR}/042-signin-grants.sql`;

function freshSchema(): string {
  const db = openDatabase(":memory:");
  const expected = readMigrations().length;
  if (schemaVersion(db) !== expected) {
    throw new Error(`user_version is ${String(schemaVersion(db))}, expected ${String(expected)}`);
  }
  const integrity = db.prepare("PRAGMA integrity_check").get()?.["integrity_check"];
  if (integrity !== "ok") throw new Error(`integrity_check: ${JSON.stringify(integrity)}`);
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("foreign_key_check found violations");
  }
  const rows = db
    .prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name")
    .all();
  return rows.map((row) => `${sqlText(row["sql"])};\n`).join("\n");
}

function sqlText(value: unknown): string {
  if (typeof value !== "string") throw new Error("sqlite_schema.sql is not text");
  return value;
}

function changedMigrations(ref: string): string[] {
  const base = execFileSync("git", ["merge-base", ref, "HEAD"], { encoding: "utf8" }).trim();
  const out = execFileSync(
    "git",
    [
      "diff",
      "--name-status",
      "--find-renames=100%",
      "--diff-filter=MDRT",
      base,
      "HEAD",
      "--",
      MIGRATIONS_DIR,
    ],
    { encoding: "utf8" },
  );
  const baseFiles = execFileSync(
    "git",
    ["ls-tree", "--name-only", base, "--", `${MIGRATIONS_DIR}/`],
    { encoding: "utf8" },
  ).split("\n");
  const baseHasDuplicate041 =
    baseFiles.includes(PLACED_HOST_041) && baseFiles.includes(SIGNIN_GRANTS_041);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !(baseHasDuplicate041 && line === SIGNIN_GRANTS_RENAME));
}

const schema = freshSchema();
if (process.argv.includes("--write")) {
  writeFileSync(SCHEMA_FILE, schema);
  console.log("wrote schema.sql");
} else if (readFileSync(SCHEMA_FILE, "utf8") !== schema) {
  throw new Error("schema.sql is out of date. Run: bun run migrations:check -- --write");
}
const base = process.env["MIGRATIONS_BASE"] ?? "";
if (base !== "" && !/^0+$/.test(base)) {
  const changed = changedMigrations(base);
  if (changed.length > 0) {
    throw new Error(
      `migrations are append-only; these changed since ${base}:\n${changed.join("\n")}`,
    );
  }
}
console.log(`migrations ok: ${String(readMigrations().length)} applied, schema.sql matches`);
