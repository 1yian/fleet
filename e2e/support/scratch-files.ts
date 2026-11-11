import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseRecord } from "./json.ts";

const LAUNCH = fileURLToPath(new URL("../../packages/extension/src/launch.ts", import.meta.url));
const DAY_MS = 86_400_000;

function launch(
  args: readonly string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [LAUNCH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status, stdout, stderr };
}

export function fleet(args: readonly string[], env: Record<string, string>): string {
  const { status, stdout, stderr } = launch(args, env);
  if (status !== 0) throw new Error(`fleet ${args.join(" ")} exited ${String(status)}: ${stderr}`);
  return stdout;
}

export const fleetResult = (
  args: readonly string[],
  env: Record<string, string>,
): { status: number | null; stderr: string } => launch(args, env);

export async function fleetAsync(
  args: readonly string[],
  env: Record<string, string>,
): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [LAUNCH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return stdout;
}

export function listing(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...listing(join(root, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

export function backdate(path: string, days: number): void {
  const then = new Date(Date.now() - days * DAY_MS);
  utimesSync(path, then, then);
}

export const withoutJiti = (names: readonly string[]): string[] =>
  names.filter((name) => !name.startsWith("tmp/jiti"));

export const tidyByHand = (hostDir: string): Record<string, unknown> =>
  parseRecord(
    fleet(["scratch", "--tidy", "--json"], { FLEET_HOST_DIR: hostDir }).trim().split("\n").at(-1) ??
      "",
  );

export function setHostSettings(hostDir: string, settings: Record<string, unknown>): string {
  mkdirSync(hostDir, { recursive: true });
  const file = join(hostDir, "host.json");
  writeFileSync(file, JSON.stringify(settings));
  return file;
}

export const clearHostSettings = (hostDir: string): void => {
  rmSync(join(hostDir, "host.json"), { force: true });
};

export const nameOf = (path: string): string => path.split("/").at(-1) ?? "";

export const scratchOf = (hostDir: string): string => join(hostDir, "scratch");

export const epochDaysAgo = (days: number): number =>
  Math.floor((Date.now() - days * DAY_MS) / 1000);

export function closedFoldersOf(hostDir: string, card: number): string[] {
  const prefix = `c-${String(card)}.closed-`;
  const root = scratchOf(hostDir);
  mkdirSync(root, { recursive: true });
  return readdirSync(root)
    .filter((name) => name.startsWith(prefix))
    .sort();
}

export function seedOpen(hostDir: string, card: number, ageDays: number): string {
  const folder = join(scratchOf(hostDir), `c-${String(card)}`);
  mkdirSync(join(folder, "tmp", "deps"), { recursive: true });
  writeFileSync(join(folder, "tmp", "deps", "index.js"), "x");
  writeFileSync(join(folder, "report.md"), "evidence");
  for (const path of [join(folder, "tmp", "deps", "index.js"), join(folder, "report.md")])
    backdate(path, ageDays);
  return folder;
}

export function seedClosed(
  hostDir: string,
  card: number,
  ageDays: number,
  evidence = "evidence",
  suffix = "",
): string {
  const name = `c-${String(card)}.closed-${String(epochDaysAgo(ageDays))}${suffix}`;
  const folder = join(scratchOf(hostDir), name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "report.md"), evidence);
  return folder;
}

export const DISPATCH = {
  title: "Run the tests",
  name: "run-the-tests",
  kind: "ship",
  project: "site",
  intent: "Run the tests",
  host: "local",
  task: "run them",
};

export const WORKER_SCRIPT = `
printf '%s\\n%s\\n%s\\n' "$FLEET_SCRATCH" "$TMPDIR" "$NODE_COMPILE_CACHE" > "$FLEET_SCRATCH/env.txt"
if [ -r /proc/$PPID/environ ]; then
  tr '\\0' '\\n' < /proc/$PPID/environ | grep -E '^(NODE_COMPILE_CACHE|TMPDIR|FLEET_SCRATCH)=' | sort > "$FLEET_SCRATCH/pi-environ.txt"
fi
echo "findings for the mate" > "$FLEET_SCRATCH/report.md"
echo "a clone that the worker made" > "$TMPDIR/clone.txt"
echo 'module.exports = 1;' > "$FLEET_SCRATCH/probe.cjs"
node "$FLEET_SCRATCH/probe.cjs"
`;

export const WATCHER_SCRIPT = `
exec 3>>"$FLEET_SCRATCH/watch.log"
(
  while :; do
    if [ -d "$TMPDIR" ]; then echo up >&3; else echo gone >&3; fi
    sleep 0.05
  done
) </dev/null >/dev/null 2>&1 &
echo $! > "$FLEET_SCRATCH/watcher.pid"
`;
