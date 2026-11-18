import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CANDIDATES = ["/var/tmp", tmpdir()];
const SUITE_DIR = /^fe-([1-9]\d*)$/;
const FILE_DIR = /^fr-([1-9]\d*)-[a-zA-Z0-9]{6}$/;

function diskBase(): string {
  for (const dir of CANDIDATES) {
    try {
      accessSync(dir, constants.W_OK);
      return dir;
    } catch {
      continue;
    }
  }
  throw new Error("no writable folder for the end-to-end run");
}

function isPrivateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700;
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!isPrivateDirectory(lstatSync(path))) {
    throw new Error(`end-to-end directory must be owned by this user and private: ${path}`);
  }
  return realpathSync(path);
}

export function runBase(): string {
  const chosen = process.env["FLEET_E2E_TMPDIR"] ?? diskBase();
  mkdirSync(chosen, { recursive: true });
  const base = realpathSync(chosen);
  return isPrivateDirectory(lstatSync(base))
    ? base
    : privateDirectory(join(base, `f${String(process.getuid?.())}`));
}

export function cacheDirectory(base: string): string {
  const path = process.env["FLEET_E2E_CACHE"] ?? join(base, "fleet-e2e-cache");
  if (!isPrivateDirectory(lstatSync(dirname(path)))) {
    throw new Error(`end-to-end cache parent must be owned by this user and private: ${path}`);
  }
  return privateDirectory(path);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function sweepStaleFolders(base: string, kind: "suite" | "file"): void {
  const form = kind === "suite" ? SUITE_DIR : FILE_DIR;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pid = Number(form.exec(entry.name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647 || processAlive(pid)) continue;
    const path = join(base, entry.name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && isPrivateDirectory(stat)) rmSync(path, { recursive: true, force: true });
  }
}
