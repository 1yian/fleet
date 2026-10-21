import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function preferenceFile(): string {
  return join(process.cwd(), "config", "calm");
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
