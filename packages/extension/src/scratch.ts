import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord } from "./lane-config.ts";

const DAY_MS = 86_400_000;

const CACHE_MAX_AGE_MS = 2 * DAY_MS;
const TMP_FOLDER = "tmp";

export function hostDir(): string {
  const set = process.env["FLEET_HOST_DIR"];
  return set !== undefined && set !== "" ? set : join(homedir(), ".fleet");
}

const HOST_SETTINGS_FILE = "host.json";
const HOST_SETTING_NAMES = ["tmpScratch"];

interface HostSettings {
  readonly tmpScratch?: string;
}

function textOf(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(
      `${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

function parsedSettings(file: string, text: string): Record<string, unknown> {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not usable: it is not valid JSON`, { cause: error });
  }
  if (!isRecord(settings)) throw new Error(`${file} is not usable: it must be a JSON object`);
  return settings;
}

function readHostSettings(file: string): HostSettings {
  const text = textOf(file);
  if (text === undefined) return {};
  const settings = parsedSettings(file, text);
  const unknown = Object.keys(settings).filter((name) => !HOST_SETTING_NAMES.includes(name));
  if (unknown.length > 0)
    throw new Error(
      `${file} is not usable: unknown setting ${unknown.map((name) => JSON.stringify(name)).join(", ")}`,
    );
  const { tmpScratch } = settings;
  if (tmpScratch === undefined) return {};
  if (typeof tmpScratch !== "string" || !isAbsolute(tmpScratch))
    throw new Error(`${file} is not usable: "tmpScratch" must be an absolute path`);
  return { tmpScratch };
}

export const tmpScratchDir = (): string =>
  readHostSettings(join(hostDir(), HOST_SETTINGS_FILE)).tmpScratch ??
  join(hostDir(), "tmp-scratch");

const compileCacheDir = (): string => join(hostDir(), "node-compile-cache");

export const SHELL_HOST_DIR = "${FLEET_HOST_DIR:-$HOME/.fleet}";

const CARD_NUMBER_ONLY =
  'case $1 in "" | *[!0-9]*) echo "not a card number: $1" >&2; exit 1 ;; esac';

export const OPEN_SCRATCH_SCRIPT = `set -eu
${CARD_NUMBER_ONLY}
dir=${SHELL_HOST_DIR}
root=$dir/scratch
scratch=$root/c-$1
cache=$dir/node-compile-cache
mkdir -p "$root" "$cache" "$scratch/${TMP_FOLDER}"
printf '%s\\n%s\\n' "$scratch" "$cache"`;

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

export interface Tidied {
  readonly cacheFiles: number;
  readonly cards: readonly string[];
}

export function tidy(now: number): Tidied {
  const cacheFiles = pruneCache(compileCacheDir(), now - CACHE_MAX_AGE_MS);
  return { cacheFiles, cards: [] };
}
