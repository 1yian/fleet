import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SYNC = fileURLToPath(new URL("../../packages/extension/src/sync.sh", import.meta.url));

export function refreshClone(path: string, base = "main"): string {
  const script = `${readFileSync(SYNC, "utf8")}\nrefresh_clone "$@"`;
  return execFileSync("sh", ["-c", script, "refresh", path, base, "fleet on p620"], {
    encoding: "utf8",
  }).trim();
}
