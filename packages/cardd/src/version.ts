import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Version } from "@fleet/protocol";
import { schemaVersion } from "./db.ts";

function ownCommit(): string | null {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    return execFileSync("git", ["-C", here, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const COMMIT = ownCommit();

export const version = (db: DatabaseSync): Version => ({
  commit: COMMIT,
  schema: schemaVersion(db),
});
