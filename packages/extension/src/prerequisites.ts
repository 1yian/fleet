import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { NO_MISTAKES_FIX, noMistakesRefusal } from "./dependencies.ts";
import { HostUnread } from "./host.ts";
import { ghLogin, type GhRun } from "./gh-login.ts";
import { discoverLanes, type Discovery } from "./lane-homes.ts";
import { isAbsent, isRecord, readLaneConfig, readRegular, verifyRegular } from "./lane-config.ts";
import { remainingMs } from "./maintenance-budget.ts";
import { declaredTiers, requiredTiers, TIERS_TEMPLATE, tiersConfigPath } from "./tiers-config.ts";

interface Tool {
  readonly name: string;
  readonly version: readonly string[];
  readonly floor?: string;
  readonly refuses?: (output: string) => string | undefined;
  readonly fix: string;
  readonly login?: { readonly fix: string };
}

const PROBE_TIMEOUT_MS = Number(process.env["FLEET_PROBE_TIMEOUT_MS"]) || 30_000;
const BREW_OR_APT = (name: string): string =>
  `brew install ${name} (macOS) or apt install ${name} (Debian)`;

const BUN: Tool = {
  name: "bun",
  version: ["--version"],
  floor: "1.3.13",
  fix: "install bun 1.3.13 or later: brew install oven-sh/bun/bun (macOS), or see https://bun.sh/docs/installation",
};

const TOOLS: readonly Tool[] = [
  {
    name: "node",
    version: ["--version"],
    floor: "24.0.0",
    fix: "install Node 24 or later: brew install node@24 (macOS), or see https://nodejs.org",
  },
  BUN,
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
    refuses: noMistakesRefusal,
    fix: NO_MISTAKES_FIX,
  },
  { name: "direnv", version: ["version"], fix: BREW_OR_APT("direnv") },
];

const versionParts = (text: string): number[] | undefined =>
  /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);

function atLeast(found: readonly number[], floor: readonly number[]): boolean {
  for (const [index, part] of floor.entries()) {
    const have = found[index] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
}

function probeProblem(
  tool: Tool,
  host: string,
  deadline?: number,
): { output: string } | { problem: string } {
  try {
    const timeout = Math.min(PROBE_TIMEOUT_MS, remainingMs(deadline));
    if (timeout === 0) throw new Error("maintenance deadline reached");
    return {
      output: execFileSync(tool.name, tool.version, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        ...(deadline === undefined ? {} : { killSignal: "SIGKILL" }),
      }),
    };
  } catch (error) {
    const missing = Reflect.get(Object(error), "code") === "ENOENT";
    const why = missing ? "is missing" : `does not run (${String(error).split("\n")[0] ?? ""})`;
    return { problem: `${tool.name} ${why} on ${host}. Fix: ${tool.fix}` };
  }
}

function versionProblem(tool: Tool, output: string, host: string): string | undefined {
  const refusal = tool.refuses?.(output);
  if (refusal !== undefined) return `${tool.name} ${refusal} on ${host}. Fix: ${tool.fix}`;
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
  if (found.state === "unknown") {
    console.error(`warning: could not check ${tool.name} login on ${host}: ${found.reason}`);
    return undefined;
  }
  return `${tool.name} is not logged in on ${host}. Fix: ${tool.login.fix}`;
}

function toolProblem(
  tool: Tool,
  host: string,
  checkLogin: boolean,
  deadline?: number,
): string | undefined {
  const probed = probeProblem(tool, host, deadline);
  if ("problem" in probed) return probed.problem;
  return (
    versionProblem(tool, probed.output, host) ?? (checkLogin ? loginProblem(tool, host) : undefined)
  );
}

export function settingsOf(home: string): Record<string, unknown> | undefined {
  const file = join(home, "config", "optchat.json");
  if (!existsSync(file)) return undefined;
  try {
    const found: unknown = JSON.parse(readRegular(file));
    return isRecord(found) ? found : {};
  } catch {
    return {};
  }
}

const PROFILE_FILES = ["AGENTS.md", "config.json"];

export function profileOf(home: string, settings: Record<string, unknown>): string {
  const memoryHome = settings["memoryHome"];
  const profile = settings["profile"];
  return join(
    resolve(home, typeof memoryHome === "string" ? memoryHome : join("data", "optchat")),
    "profiles",
    typeof profile === "string" ? profile : "",
  );
}

export interface SweepSnapshot {
  readonly retained: string[];
  readonly unreadable: Map<string, string>;
  readonly memory: Map<string, string>;
  readonly discovered: Discovery;
}

export function tierProblems(root: string, host: string): string[] {
  const path = tiersConfigPath();
  let config: unknown;
  let state = "does not declare every tier";
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    state =
      Reflect.get(Object(error), "code") === "ENOENT" ? "does not exist" : "is not valid JSON";
  }
  const declared = declaredTiers(config);
  const missing = requiredTiers().filter((name) => !declared.includes(name));
  if (missing.length === 0) return [];
  const fix = `run ${join(root, "bin", "fleet")} install, which writes ${TIERS_TEMPLATE} there when the file does not exist, or give each of them a tier with a non-empty chain in it`;
  return [
    `tiers are not configured on ${host}: ${path} ${state}. Missing tiers (${String(missing.length)}): ${missing.join(", ")}. Fix: ${fix}`,
  ];
}

export const newSnapshot = (retained: string[], discovered: Discovery): SweepSnapshot => ({
  retained,
  unreadable: new Map(),
  memory: new Map(),
  discovered,
});

export const eligibleLanes = (snapshot: SweepSnapshot): Discovery => ({
  homes: snapshot.discovered.homes.filter(({ lane }) => !snapshot.unreadable.has(lane)),
  unread: [
    ...snapshot.discovered.unread,
    ...[...snapshot.unreadable].map(([lane, message]) => ({ lane, message })),
  ],
  confirm: (info) => {
    confirmMemory(snapshot, info);
  },
});

function strictSettings(home: string): {
  settings: Record<string, unknown> | undefined;
  text: string | undefined;
} {
  const file = join(home, "config", "optchat.json");
  let text: string;
  try {
    text = readRegular(file);
  } catch (error) {
    if (isAbsent(file, error)) return { settings: undefined, text: undefined };
    throw error;
  }
  let found: unknown;
  try {
    found = JSON.parse(text);
  } catch {
    throw new Error("config/optchat.json is not valid JSON");
  }
  if (!isRecord(found)) throw new Error("config/optchat.json is not a JSON object");
  return { settings: found, text };
}

function regularInputPresent(path: string): boolean {
  try {
    verifyRegular(path);
    return true;
  } catch (error) {
    if (isAbsent(path, error)) return false;
    throw error;
  }
}

function missingProfileFiles(
  home: string,
  settings: Record<string, unknown> | undefined,
  present: (path: string) => boolean,
): string[] {
  if (settings === undefined || settings["enabled"] === false) return [];
  const profile = profileOf(home, settings);
  return PROFILE_FILES.filter((file) => !present(join(profile, file)));
}

const fingerprintOf = (text: string | undefined, missing: readonly string[]): string =>
  JSON.stringify([text ?? null, missing]);

function confirmMemory(snapshot: SweepSnapshot, info: { lane: string; home: string }): void {
  let now: string;
  try {
    const { settings, text } = strictSettings(info.home);
    now = fingerprintOf(text, missingProfileFiles(info.home, settings, regularInputPresent));
  } catch {
    throw new HostUnread(
      `${info.lane} optchat settings could not be read again after they were checked`,
    );
  }
  if (now !== snapshot.memory.get(info.lane))
    throw new HostUnread(`${info.lane} optchat settings changed after they were checked`);
}

function memoryProblem(
  root: string,
  host: string,
  home: { lane: string; home: string },
  snapshot?: SweepSnapshot,
): string[] {
  let settings: Record<string, unknown> | undefined;
  let text: string | undefined;
  let missing: string[];
  try {
    if (snapshot === undefined) {
      settings = settingsOf(home.home);
      missing = missingProfileFiles(home.home, settings, existsSync);
    } else {
      ({ settings, text } = strictSettings(home.home));
      missing = missingProfileFiles(home.home, settings, regularInputPresent);
    }
  } catch (error) {
    if (snapshot === undefined) throw error;
    const why = error instanceof Error ? error.message : String(error);
    if (home.home === root)
      snapshot.retained.push(`optchat settings of lane ${home.lane} could not be read: ${why}`);
    else snapshot.unreadable.set(home.lane, `optchat settings could not be read: ${why}`);
    return [];
  }
  snapshot?.memory.set(home.lane, fingerprintOf(text, missing));
  if (settings === undefined || missing.length === 0) return [];
  const profile = profileOf(home.home, settings);
  const fix = `Fix: ${join(root, "bin", "fleet")} home memory ${home.lane}`;
  return [
    `optchat of lane ${home.lane} has no ${missing.join(" and ")} in profile ${profile} on ${host}. ${fix}`,
  ];
}

function memoryProblems(root: string, host: string, snapshot?: SweepSnapshot): string[] {
  let main: ReturnType<typeof readLaneConfig>;
  try {
    main = readLaneConfig(root);
  } catch (error) {
    if (snapshot === undefined) throw error;
    snapshot.retained.push(
      `root lane config could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const homes = [
    ...(main === undefined ? [] : [{ lane: main.lane, home: root }]),
    ...(snapshot?.discovered ?? discoverLanes(root)).homes,
  ];
  return homes.flatMap((each) => memoryProblem(root, host, each, snapshot));
}

export const bunProblems = (): string[] => [toolProblem(BUN, hostname(), false) ?? []].flat();

export function hostProblems(
  root: string,
  checkLogin = true,
  deadline?: number,
  snapshot?: SweepSnapshot,
): string[] {
  const host = hostname();
  return [
    ...TOOLS.flatMap((tool) => toolProblem(tool, host, checkLogin, deadline) ?? []),
    ...tierProblems(root, host),
    ...memoryProblems(root, host, snapshot),
  ];
}
