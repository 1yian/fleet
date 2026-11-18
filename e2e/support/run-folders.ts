import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const CANDIDATES = ["/var/tmp", tmpdir()];

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

export function verifyPrivateDirectory(path: string): void {
  verifyAncestors(path);
  if (!isPrivateDirectory(lstatSync(path))) {
    throw new Error(`end-to-end directory must be owned by this user and private: ${path}`);
  }
}

export function cacheDirectory(base: string): string {
  verifyPrivateDirectory(base);
  return privateDirectory(join(base, "fleet-e2e-cache"));
}
