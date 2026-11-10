import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseRecord } from "./json.ts";

const LAUNCH = fileURLToPath(new URL("../../packages/extension/src/launch.ts", import.meta.url));
const DAY_MS = 86_400_000;

export const fleet = (args: readonly string[], env: Record<string, string>): string =>
  execFileSync(process.execPath, [LAUNCH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

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

export function seedCard(root: string, name: string, ageDays: number, closed: boolean): string {
  const card = join(root, "scratch", name);
  mkdirSync(join(card, "tmp", "deps"), { recursive: true });
  writeFileSync(join(card, "tmp", "deps", "index.js"), "x");
  writeFileSync(join(card, "report.md"), "evidence");
  if (closed) writeFileSync(join(card, "closed"), "");
  for (const path of [join(card, "tmp", "deps", "index.js"), join(card, "report.md")])
    backdate(path, ageDays);
  if (closed) backdate(join(card, "closed"), ageDays);
  return card;
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

const HOSTNAME = hostname();

export function lockCard(hostDir: string, card: number, pid: number): string {
  const lock = join(hostDir, "scratch", `.lock-c-${String(card)}`);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), `${String(pid)} ${HOSTNAME}\n`);
  return lock;
}

export const ownerLine = (pid: number): string => `${String(pid)} ${HOSTNAME}\n`;

export const deadPid = (): number =>
  Number(execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim());
