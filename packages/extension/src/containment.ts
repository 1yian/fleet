import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onHost, piPids, shellPid } from "./host.ts";

const script = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./contain/${name}.sh`, import.meta.url)), "utf8");

const BACKENDS = ["systemd", "cgroup", "sweep"] as const;

type Backend = (typeof BACKENDS)[number];

const DETECT = script("detect");

export const SERVICE_SCRIPT = script("service");

const scriptFor = (backend: Backend): string =>
  [script("lib"), SERVICE_SCRIPT, script(backend), script("main")].join("\n");

const known = new Map<string, Promise<Backend>>();

function asBackend(name: string): Backend {
  const found = BACKENDS.find((each) => each === name.trim());
  if (found === undefined) throw new Error(`unknown containment backend "${name.trim()}"`);
  return found;
}

function backendOn(host: string): Promise<Backend> {
  let found = known.get(host);
  if (found === undefined) {
    found = onHost(host, ["sh", "-c", DETECT]).then(asBackend);
    known.set(host, found);
    found.catch(() => known.delete(host));
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

const SHELL_WAIT_TRIES = 50;

async function pidsIn(host: string, pane: string, tries: number): Promise<number[]> {
  for (let attempt = 1; ; attempt++) {
    const shell = await shellPid(host, pane);
    const pids = [...(shell === undefined ? [] : [shell]), ...(await piPids(host, pane))];
    if (pids.length > 0) return pids;
    if (attempt >= tries) throw new Error(`no process to contain in pane ${pane} on ${host}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function contain(host: string, pane: string, worktree: string): Promise<void> {
  await run(host, "attach", worktree, await pidsIn(host, pane, 1));
}

export async function joinContained(host: string, pane: string, worktree: string): Promise<void> {
  await run(host, "join", worktree, await pidsIn(host, pane, SHELL_WAIT_TRIES));
}

export async function releaseAll(host: string, worktree: string): Promise<string> {
  const out = await run(host, "kill", worktree, []);
  if (out.split("\n").some((line) => line.split("\t")[1] === "ALIVE"))
    throw new Error(`processes of ${worktree} on ${host} survived containment cleanup`);
  return out;
}
