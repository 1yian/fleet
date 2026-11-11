import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;

const CACHE_MAX_AGE_MS = 2 * DAY_MS;
const CLOSED_KEEP_MS = 7 * DAY_MS;

const CLOSED_FOLDER = /^c-(\d+)\.closed-(\d+)(?:-\d+)?$/;
const TMP_FOLDER = "tmp";
const REMOVING_PREFIX = ".removing-";

export function hostDir(): string {
  const set = process.env["FLEET_HOST_DIR"];
  return set !== undefined && set !== "" ? set : join(homedir(), ".fleet");
}

const compileCacheDir = (): string => join(hostDir(), "node-compile-cache");

const scratchRoot = (): string => join(hostDir(), "scratch");

const SHELL_HOST_DIR = "${FLEET_HOST_DIR:-$HOME/.fleet}";

const CARD_NUMBER_ONLY =
  'case $1 in "" | *[!0-9]*) echo "not a card number: $1" >&2; exit 1 ;; esac';

const RENAME_DIR = `rename_dir() { node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2" 2>/dev/null; }`;

export const OPEN_SCRATCH_SCRIPT = `set -eu
${CARD_NUMBER_ONLY}
dir=${SHELL_HOST_DIR}
root=$dir/scratch
scratch=$root/c-$1
cache=$dir/node-compile-cache
${RENAME_DIR}
mkdir -p "$root" "$cache"
if [ ! -e "$scratch" ]; then
  latest= best_epoch=0 best_k=0
  for closed in "$root/c-$1.closed-"*; do
    [ -d "$closed" ] && [ ! -L "$closed" ] || continue
    stamp=\${closed##*.closed-}
    epoch=\${stamp%%-*}
    k=0
    case $stamp in *-*) k=\${stamp#*-} ;; esac
    case $epoch in "" | *[!0-9]*) continue ;; esac
    case $k in "" | *[!0-9]*) continue ;; esac
    if [ -z "$latest" ] || [ "$epoch" -gt "$best_epoch" ] || { [ "$epoch" -eq "$best_epoch" ] && [ "$k" -gt "$best_k" ]; }; then
      latest=$closed best_epoch=$epoch best_k=$k
    fi
  done
  if [ -n "$latest" ]; then rename_dir "$latest" "$scratch" || true; fi
fi
mkdir -p "$scratch/${TMP_FOLDER}"
[ -d "$scratch/${TMP_FOLDER}" ] || { echo "cannot make $scratch/${TMP_FOLDER}" >&2; exit 1; }
printf '%s\\n%s\\n' "$scratch" "$cache"`;

export const CLOSE_SCRATCH_SCRIPT = `set -eu
${CARD_NUMBER_ONLY}
dir=${SHELL_HOST_DIR}
root=$dir/scratch
scratch=$root/c-$1
${RENAME_DIR}
[ -d "$scratch" ] && [ ! -L "$scratch" ] || exit 0
rm -rf "$scratch/${TMP_FOLDER}" || true
if [ -z "$(ls -A "$scratch")" ]; then
  rmdir "$scratch" || true
  exit 0
fi
stamp=$(date +%s)
closed=$root/c-$1.closed-$stamp
tries=0
while [ -e "$closed" ] && [ "$tries" -lt 100 ]; do
  tries=$((tries + 1))
  closed=$root/c-$1.closed-$stamp-$tries
done
rename_dir "$scratch" "$closed" || true`;

export interface WorkerScratch {
  readonly scratch: string;
  readonly cache: string;
}

export function parseOpened(output: string): WorkerScratch {
  const [scratch = "", cache = ""] = output.trim().split("\n");
  if (scratch === "" || cache === "")
    throw new Error(`the host did not name a scratch folder: ${JSON.stringify(output)}`);
  return { scratch, cache };
}

export const workerEnvironment = ({ scratch, cache }: WorkerScratch): string[] => [
  `FLEET_SCRATCH=${scratch}`,
  `TMPDIR=${join(scratch, TMP_FOLDER)}`,
  `NODE_COMPILE_CACHE=${cache}`,
];

const FORWARDED = ["FLEET_SCRATCH", "TMPDIR", "NODE_COMPILE_CACHE"] as const;

export function forwardedEnvironment(env: NodeJS.ProcessEnv): string[] {
  const scratch = env["FLEET_SCRATCH"];
  if (scratch === undefined || scratch === "") return [];
  return FORWARDED.flatMap((name) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [`${name}=${value}`];
  });
}

export const withCompileCache = (command: readonly string[]): string[] => [
  "env",
  `NODE_COMPILE_CACHE=${compileCacheDir()}`,
  ...command,
];

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    return;
  }
}

function removeOld(path: string, cutoff: number): number {
  try {
    if (lstatSync(path).mtimeMs >= cutoff) return 0;
    unlinkSync(path);
    return 1;
  } catch {
    return 0;
  }
}

function pruneCache(dir: string, cutoff: number): number {
  let removed = 0;
  for (const entry of entriesOf(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += pruneCache(path, cutoff);
      removeEmptyDirectory(path);
    } else if (entry.isFile()) removed += removeOld(path, cutoff);
  }
  return removed;
}

function removed(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function claimed(root: string, name: string): boolean {
  const aside = join(root, `${REMOVING_PREFIX}${String(process.pid)}-${randomUUID()}`);
  try {
    renameSync(join(root, name), aside);
  } catch {
    return false;
  }
  return removed(aside);
}

function tidyClosedCards(now: number): string[] {
  const root = scratchRoot();
  const folders = entriesOf(root).filter((entry) => entry.isDirectory());
  for (const { name } of folders) {
    if (name.startsWith(REMOVING_PREFIX)) removed(join(root, name));
  }
  const gone = new Set<string>();
  for (const { name } of folders) {
    const [, card = "", closedAt = ""] = CLOSED_FOLDER.exec(name) ?? [];
    if (card === "" || now - Number(closedAt) * 1000 < CLOSED_KEEP_MS) continue;
    if (claimed(root, name)) gone.add(`c-${card}`);
  }
  return [...gone];
}

export interface Tidied {
  readonly cacheFiles: number;
  readonly cards: readonly string[];
}

export function tidy(now: number): Tidied {
  const cacheFiles = pruneCache(compileCacheDir(), now - CACHE_MAX_AGE_MS);
  return { cacheFiles, cards: tidyClosedCards(now) };
}
