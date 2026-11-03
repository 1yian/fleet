import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onHost, piPids } from "./host.ts";

const script = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./contain/${name}.sh`, import.meta.url)), "utf8");

const BACKENDS = ["systemd", "cgroup", "sweep"] as const;

type Backend = (typeof BACKENDS)[number];

const DETECT = script("detect");

const scriptFor = (backend: Backend): string =>
  [script("lib"), script(backend), script("main")].join("\n");

const known = new Map<string, Promise<Backend>>();

const asBackend = (name: string): Backend =>
  BACKENDS.find((each) => each === name.trim()) ?? "sweep";

function backendOn(host: string): Promise<Backend> {
  let found = known.get(host);
  if (found === undefined) {
    found = onHost(host, ["sh", "-c", DETECT]).then(asBackend, () => "sweep" as const);
    known.set(host, found);
  }
  return found;
}

async function run(
  host: string,
  action: string,
  worktree: string,
  pids: number[],
): Promise<string> {
  const backend = await backendOn(host);
  return onHost(host, [
    "sh",
    "-c",
    scriptFor(backend),
    "contain",
    action,
    worktree,
    ...pids.map(String),
  ]);
}

export async function contain(host: string, pane: string, worktree: string): Promise<void> {
  const pids = await piPids(host, pane).catch(() => []);
  if (pids.length === 0) return;
  await run(host, "attach", worktree, pids).catch(() => undefined);
}

export async function releaseAll(host: string, worktree: string): Promise<string> {
  return run(host, "kill", worktree, []).catch(() => "");
}

const announced = new Set<string>();

export async function announce(host: string): Promise<string> {
  const backend = await backendOn(host);
  if (announced.has(host)) return "";
  announced.add(host);
  return ` Process containment on ${host}: ${backend}.`;
}
