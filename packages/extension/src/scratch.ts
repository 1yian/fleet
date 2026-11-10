import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;

const CACHE_MAX_AGE_MS = 2 * DAY_MS;
const CLOSED_KEEP_MS = 7 * DAY_MS;

const CARD_FOLDER = /^c-\d+$/;
const CLOSED_MARK = "closed";
const TMP_FOLDER = "tmp";
const REMOVING_PREFIX = ".removing-";
const STALE_PREFIX = ".stale-";
const LOCK_PREFIX = ".lock-";
const LOCK_STALE_AFTER_S = 60;
const OPEN_LOCK_WAIT_MS = 30_000;
const CLOSE_LOCK_WAIT_MS = 5000;

export function hostDir(): string {
  const set = process.env["FLEET_HOST_DIR"];
  return set !== undefined && set !== "" ? set : join(homedir(), ".fleet");
}

const compileCacheDir = (): string => join(hostDir(), "node-compile-cache");

const scratchRoot = (): string => join(hostDir(), "scratch");

const SHELL_HOST_DIR = "${FLEET_HOST_DIR:-$HOME/.fleet}";

const CARD_NUMBER_ONLY =
  'case $1 in "" | *[!0-9]*) echo "not a card number: $1" >&2; exit 1 ;; esac';

const LOCK_FUNCTIONS = `mtime_s() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
lock_is_stale() {
  lk_stamp=$(mtime_s "$1") || return 1
  [ $(( $(date +%s) - lk_stamp )) -gt ${String(LOCK_STALE_AFTER_S)} ] && return 0
  lk_owner=$(cat "$1/owner" 2>/dev/null) || return 1
  [ "\${lk_owner#* }" = "$(hostname)" ] || return 1
  lk_pid=\${lk_owner%% *}
  case $lk_pid in "" | *[!0-9]*) return 1 ;; esac
  ! kill -0 "$lk_pid" 2>/dev/null
}
lock_take() {
  lk_held=$1 lk_limit=$2 lk_waited=0 lk_takeovers=0
  while :; do
    if mkdir "$lk_held" 2>/dev/null; then
      printf '%s %s\\n' "$$" "$(hostname)" > "$lk_held/owner" && return 0
      rmdir "$lk_held" 2>/dev/null
      return 1
    fi
    if lock_is_stale "$lk_held"; then
      lk_takeovers=$((lk_takeovers + 1))
      [ "$lk_takeovers" -le 20 ] || return 1
      lk_judged=$(cat "$lk_held/owner" 2>/dev/null || true)
      lk_aside=\${lk_held%/*}/${STALE_PREFIX}$$-$lk_takeovers
      if mv "$lk_held" "$lk_aside" 2>/dev/null; then
        if [ "$(cat "$lk_aside/owner" 2>/dev/null || true)" = "$lk_judged" ]; then
          rm -rf "$lk_aside"
        elif [ ! -e "$lk_held" ]; then
          mv "$lk_aside" "$lk_held" 2>/dev/null || true
        fi
      fi
      continue
    fi
    [ "$lk_waited" -lt "$lk_limit" ] || return 1
    sleep 0.1 2>/dev/null || sleep 1
    lk_waited=$((lk_waited + 100))
  done
}
lock_release() {
  lk_owner=$(cat "$1/owner" 2>/dev/null) || return 0
  [ "\${lk_owner%% *}" = "$$" ] || return 0
  rm -f "$1/owner"
  rmdir "$1" 2>/dev/null || true
}`;

const wait = (fallback: number): string =>
  `wait_ms=\${FLEET_SCRATCH_LOCK_WAIT_MS:-${String(fallback)}}
case $wait_ms in "" | *[!0-9]*) wait_ms=${String(fallback)} ;; esac`;

export const OPEN_SCRATCH_SCRIPT = `set -eu
${CARD_NUMBER_ONLY}
dir=${SHELL_HOST_DIR}
root=$dir/scratch
scratch=$root/c-$1
cache=$dir/node-compile-cache
lock=$root/${LOCK_PREFIX}c-$1
${wait(OPEN_LOCK_WAIT_MS)}
${LOCK_FUNCTIONS}
mkdir -p "$root" "$cache"
if ! lock_take "$lock" "$wait_ms"; then
  held_by=$(cat "$lock/owner" 2>/dev/null || echo unknown)
  echo "cannot reopen c-$1: its scratch folder $scratch is locked by $held_by (lock $lock) and the lock did not clear within $wait_ms ms, so no worker was started" >&2
  exit 1
fi
trap 'lock_release "$lock"' EXIT
rm -f "$scratch/${CLOSED_MARK}"
mkdir -p "$scratch/${TMP_FOLDER}"
printf '%s\\n%s\\n' "$scratch" "$cache"`;

export const CLOSE_SCRATCH_SCRIPT = `set -eu
${CARD_NUMBER_ONLY}
dir=${SHELL_HOST_DIR}
root=$dir/scratch
scratch=$root/c-$1
lock=$root/${LOCK_PREFIX}c-$1
${wait(CLOSE_LOCK_WAIT_MS)}
${LOCK_FUNCTIONS}
[ -d "$scratch" ] || exit 0
lock_take "$lock" "$wait_ms" || exit 0
trap 'lock_release "$lock"' EXIT
[ -d "$scratch" ] || exit 0
aside=$root/${REMOVING_PREFIX}$$-c-$1
if [ -e "$scratch/${TMP_FOLDER}" ]; then
  mv "$scratch/${TMP_FOLDER}" "$aside" 2>/dev/null || aside=
else
  aside=
fi
if [ -z "$(ls -A "$scratch")" ]; then
  rmdir "$scratch" || true
elif [ ! -e "$scratch/${CLOSED_MARK}" ]; then
  : > "$scratch/${CLOSED_MARK}"
fi
lock_release "$lock"
if [ -n "$aside" ]; then rm -rf "$aside" || true; fi`;

const TAKE_AWAY_SCRIPT = `set -u
root=$1 card=$2 part=$3 aside=$4 now=$5 min_age=$6
lock=$root/${LOCK_PREFIX}$card
${LOCK_FUNCTIONS}
lock_take "$lock" 0 || exit 0
trap 'lock_release "$lock"' EXIT
mark=$root/$card/${CLOSED_MARK}
if [ -L "$root/$card" ] || [ ! -f "$mark" ] || [ -L "$mark" ]; then exit 0; fi
stamp=$(mtime_s "$mark") || exit 0
[ $(( now - stamp )) -ge "$min_age" ] || exit 0
target=$root/$card
if [ -n "$part" ]; then target=$target/$part; fi
mv "$target" "$root/$aside" 2>/dev/null || exit 0
echo moved`;

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

function takeAway(card: string, part: string, now: number, minAgeMs: number): boolean {
  const root = scratchRoot();
  const aside = `${REMOVING_PREFIX}${String(process.pid)}-${card}`;
  const seconds = (ms: number): string => String(Math.floor(ms / 1000));
  let out: string;
  try {
    out = execFileSync(
      "sh",
      ["-c", TAKE_AWAY_SCRIPT, "take", root, card, part, aside, seconds(now), seconds(minAgeMs)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return false;
  }
  return out.trim() === "moved" && removed(join(root, aside));
}

function tidyClosedCards(now: number): string[] {
  const root = scratchRoot();
  const gone: string[] = [];
  const folders = entriesOf(root).filter((entry) => entry.isDirectory());
  for (const { name } of folders) {
    if (name.startsWith(REMOVING_PREFIX) || name.startsWith(STALE_PREFIX))
      removed(join(root, name));
  }
  for (const { name: card } of folders.filter((entry) => CARD_FOLDER.test(entry.name))) {
    const closed = closedSince(card);
    if (closed === undefined) continue;
    if (now - closed < CLOSED_KEEP_MS) takeAway(card, TMP_FOLDER, now, 0);
    else if (takeAway(card, "", now, CLOSED_KEEP_MS)) gone.push(card);
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
