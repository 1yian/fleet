import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { ghLogin, type GhRun } from "./gh-login.ts";
import { laneHomes } from "./homes.ts";
import { isRecord, readLaneConfig } from "./lane-config.ts";
import { agentDir, packageProblem } from "./memory.ts";

interface Tool {
  readonly name: string;
  readonly version: readonly string[];
  readonly floor?: string;
  readonly fix: string;
  readonly login?: { readonly fix: string };
}

const PROBE_TIMEOUT_MS = Number(process.env["FLEET_PROBE_TIMEOUT_MS"]) || 30_000;
const PACKAGE = join("config", "optchat", "package");
const BREW_OR_APT = (name: string): string =>
  `brew install ${name} (macOS) or apt install ${name} (Debian)`;

const TOOLS: readonly Tool[] = [
  {
    name: "node",
    version: ["--version"],
    floor: "24.0.0",
    fix: "install Node 24 or later: brew install node@24 (macOS), or see https://nodejs.org",
  },
  { name: "git", version: ["--version"], floor: "2.31.0", fix: BREW_OR_APT("git") },
  {
    name: "gh",
    version: ["--version"],
    fix: BREW_OR_APT("gh"),
    login: { fix: "gh auth login" },
  },
  {
    name: "herdr",
    version: ["--version"],
    floor: "0.9.5",
    fix: "install herdr 0.9.5 or later from https://github.com/herdrdev/herdr/releases",
  },
  { name: "zstd", version: ["--version"], fix: BREW_OR_APT("zstd") },
  {
    name: "no-mistakes",
    version: ["--version"],
    fix: "curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh",
  },
  { name: "direnv", version: ["version"], fix: BREW_OR_APT("direnv") },
];

const LAVISH: Tool = {
  name: "lavish-axi",
  version: ["--version"],
  floor: "0.1.80",
  fix: "npm install -g lavish-axi",
};

const versionParts = (text: string): number[] | undefined =>
  /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);

function atLeast(found: readonly number[], floor: readonly number[]): boolean {
  for (const [index, part] of floor.entries()) {
    const have = found[index] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
}

const run = (file: string, args: readonly string[]): string =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
  });

function probeProblem(tool: Tool, host: string): { output: string } | { problem: string } {
  try {
    return { output: run(tool.name, tool.version) };
  } catch (error) {
    const missing = Reflect.get(Object(error), "code") === "ENOENT";
    const why = missing ? "is missing" : `does not run (${String(error).split("\n")[0] ?? ""})`;
    return { problem: `${tool.name} ${why} on ${host}. Fix: ${tool.fix}` };
  }
}

function versionProblem(tool: Tool, output: string, host: string): string | undefined {
  const floor = versionParts(tool.floor ?? "");
  if (floor === undefined) return undefined;
  const found = versionParts(output);
  if (found !== undefined && atLeast(found, floor)) return undefined;
  return `${tool.name} ${found?.join(".") ?? "(no version)"} is too old on ${host} (need ${tool.floor ?? ""} or later). Fix: ${tool.fix}`;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

function spawnError(
  file: string,
  done: SpawnSyncReturns<string>,
  timedOut: boolean,
): string | undefined {
  if (done.error !== undefined && !timedOut) return `${file} could not run (${done.error.message})`;
  return done.signal === null || timedOut ? undefined : `${file} was stopped by ${done.signal}`;
}

function runCaptured(file: string, args: readonly string[]): GhRun {
  const done = spawnSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
  });
  const timedOut = Reflect.get(Object(done.error), "code") === "ETIMEDOUT";
  return {
    stdout: textOf(done.stdout),
    stderr: textOf(done.stderr),
    code: done.status ?? undefined,
    timedOut,
    spawnError: spawnError(file, done, timedOut),
  };
}

function loginProblem(tool: Tool, host: string): string | undefined {
  if (tool.login === undefined) return undefined;
  const found = ghLogin((args) => runCaptured(tool.name, args), PROBE_TIMEOUT_MS / 1000);
  if (found.state === "logged-in") return undefined;
  if (found.state === "unknown")
    return `could not check ${tool.name} login on ${host}: ${found.reason}`;
  return `${tool.name} is not logged in on ${host}. Fix: ${tool.login.fix}`;
}

function toolProblem(tool: Tool, host: string): string | undefined {
  const probed = probeProblem(tool, host);
  if ("problem" in probed) return probed.problem;
  return versionProblem(tool, probed.output, host) ?? loginProblem(tool, host);
}

function settingsOf(home: string): Record<string, unknown> | undefined {
  const file = join(home, "config", "optchat.json");
  if (!existsSync(file)) return undefined;
  try {
    const found: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(found) ? found : {};
  } catch {
    return {};
  }
}

function memoryProblems(root: string, host: string): string[] {
  const agent = agentDir();
  const loader = join(agent, "extensions", "fm-optchat", "index.ts");
  const helper = join(agent, "optchat", "package.mjs");
  const homes = [
    ...(readLaneConfig(root) === undefined
      ? []
      : [{ lane: readLaneConfig(root)?.lane, home: root }]),
    ...laneHomes(root),
  ];
  return homes.flatMap(({ lane, home }) => {
    const settings = settingsOf(home);
    if (settings === undefined || settings["enabled"] === false) return [];
    const of = `optchat of lane ${lane ?? ""}`;
    const fix = `Fix: ${join(root, "bin", "fleet")} home memory ${lane ?? ""}`;
    if (!existsSync(loader) || !existsSync(helper))
      return [
        `${of} has no loader in ${agent} on ${host}. Fix: install extensions/fm-optchat and optchat from the dotfiles repository (home/.pi/agent) into ${agent}`,
      ];
    const configured = settings["package"];
    const target = resolve(home, typeof configured === "string" ? configured : PACKAGE);
    if (!existsSync(target)) return [`${of} is missing its package ${target} on ${host}. ${fix}`];
    const problem = packageProblem(realpathSync(helper), target);
    return problem === undefined
      ? []
      : [`${of} has a stale or broken package ${target} on ${host}: ${problem}. ${fix}`];
  });
}

export function hostProblems(root: string): string[] {
  const host = hostname();
  return [...TOOLS.flatMap((tool) => toolProblem(tool, host) ?? []), ...memoryProblems(root, host)];
}

export const lavishProblem = (): string | undefined => toolProblem(LAVISH, hostname());
