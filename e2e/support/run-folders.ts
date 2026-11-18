import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const CANDIDATES = ["/var/tmp", tmpdir()];
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

function verifyAncestors(path: string): void {
  const parent = dirname(path);
  if (parent !== path) verifyAncestors(parent);
  const stat = lstatSync(path);
  const writable = (stat.mode & 0o022) !== 0;
  if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      (writable && (stat.mode & 0o1000) === 0)) {
    throw new Error(`replaceable end-to-end directory: ${path}`);
  }
}

function verifiedPath(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = verifiedPath(dirname(path));
    canonical = join(parent, basename(path));
    mkdirSync(canonical, { recursive: true, mode: 0o700 });
  }
  verifyAncestors(canonical);
  return canonical;
}

export function runBase(): string {
  const chosen = process.env["FLEET_E2E_TMPDIR"] ?? diskBase();
  const base = verifiedPath(resolve(chosen));
  return isPrivateDirectory(lstatSync(base))
    ? base
    : privateDirectory(join(base, `f${String(process.getuid?.())}`));
}

export function cacheDirectory(base: string): string {
  verifyAncestors(base);
  if (!isPrivateDirectory(lstatSync(base))) {
    throw new Error(`end-to-end cache base must be owned by this user and private: ${base}`);
  }
  return privateDirectory(join(base, "fleet-e2e-cache"));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function sweepStaleFileFolders(base: string): void {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pid = Number(FILE_DIR.exec(entry.name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647 || processAlive(pid)) continue;
    const path = join(base, entry.name);
    if (existsSync(join(path, "unresolved-groups"))) continue;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && isPrivateDirectory(stat)) rmSync(path, { recursive: true, force: true });
  }
}
