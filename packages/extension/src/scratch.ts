import { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;

const CACHE_MAX_AGE_MS = 2 * DAY_MS;
const CLOSED_KEEP_MS = 7 * DAY_MS;

const CARD_FOLDER = /^c-\d+$/;
const CLOSED_MARK = "closed";
const TMP_FOLDER = "tmp";

export function hostDir(): string {
  const set = process.env["FLEET_HOST_DIR"];
  return set !== undefined && set !== "" ? set : join(homedir(), ".fleet");
}

const compileCacheDir = (): string => join(hostDir(), "node-compile-cache");

const scratchRoot = (): string => join(hostDir(), "scratch");

const SHELL_HOST_DIR = "${FLEET_HOST_DIR:-$HOME/.fleet}";

const CARD_NUMBER_ONLY =
  'case $1 in "" | *[!0-9]*) echo "not a card number: $1" >&2; exit 1 ;; esac';

export const OPEN_SCRATCH_SCRIPT = `set -eu
${CARD_NUMBER_ONLY}
dir=${SHELL_HOST_DIR}
scratch=$dir/scratch/c-$1
cache=$dir/node-compile-cache
mkdir -p "$scratch/${TMP_FOLDER}" "$cache"
rm -f "$scratch/${CLOSED_MARK}"
printf '%s\\n%s\\n' "$scratch" "$cache"`;

export const CLOSE_SCRATCH_SCRIPT = `set -eu
${CARD_NUMBER_ONLY}
dir=${SHELL_HOST_DIR}
scratch=$dir/scratch/c-$1
[ -d "$scratch" ] || exit 0
rm -rf "$scratch/${TMP_FOLDER}" || true
if [ -z "$(ls -A "$scratch")" ]; then
  rmdir "$scratch" || true
elif [ ! -e "$scratch/${CLOSED_MARK}" ]; then
  : > "$scratch/${CLOSED_MARK}"
fi`;

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

function closedSince(card: string): number | undefined {
  try {
    return lstatSync(join(scratchRoot(), card, CLOSED_MARK)).mtimeMs;
  } catch {
    return undefined;
  }
}

function removed(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function tidyClosedCards(now: number): string[] {
  const root = scratchRoot();
  const gone: string[] = [];
  const folders = entriesOf(root).filter(
    (entry) => entry.isDirectory() && CARD_FOLDER.test(entry.name),
  );
  for (const { name: card } of folders) {
    const closed = closedSince(card);
    if (closed === undefined) continue;
    const folder = join(root, card);
    if (now - closed < CLOSED_KEEP_MS) removed(join(folder, TMP_FOLDER));
    else if (removed(folder)) gone.push(card);
  }
  return gone;
}

export interface Tidied {
  readonly cacheFiles: number;
  readonly cards: readonly string[];
}

export function tidy(now: number): Tidied {
  const cacheFiles = pruneCache(compileCacheDir(), now - CACHE_MAX_AGE_MS);
  return { cacheFiles, cards: tidyClosedCards(now) };
}
