// The Calm preference: one file per mate home, config/calm, holding "on" or "off".
// An absent, unreadable, or unrecognized file means off. Each write replaces the file
// atomically, so a crash never leaves half a value.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The mate's home: FLEET_HOME (set by `fleet <lane>`), else the folder Pi runs in. */
export function preferenceFile(): string {
  return join(process.env["FLEET_HOME"] ?? process.cwd(), "config", "calm");
}

export function loadPreference(file: string): boolean {
  try {
    return readFileSync(file, "utf8").trim() === "on";
  } catch {
    return false;
  }
}

export function savePreference(file: string, active: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, active ? "on\n" : "off\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
