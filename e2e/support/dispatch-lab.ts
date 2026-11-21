import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cardd } from "./cardd.ts";
import { Harness, type Move, type Pi, type Turn } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";
import { RepeatProxy, type MateRoute } from "./repeat-proxy.ts";
import { addRemote, git as gitIn } from "./remote.ts";
import { tempDir } from "./run-root.ts";

export const WORKER_WAIT_MS = 60_000;
const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SWITCH = fileURLToPath(new URL("./switch-transport.ts", import.meta.url));
const FLAKY = fileURLToPath(new URL("./flaky-transport.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

export interface DispatchLab {
  readonly cardd: Cardd;
  readonly h: Harness;
  readonly lab: HerdrLab;
  readonly clone: string;
  readonly remote: string | undefined;
  readonly mate: Pi;
  readonly home: string;
  readonly mainToken: string;
  readonly route: MateRoute | undefined;
}

export const launchArgsOf = (h: Harness): string => join(h.dir, "worker-args");
export const avoidSeenOf = (h: Harness): string => join(h.dir, "worker-avoid");

export interface LabOptions {
  readonly cardd?: Record<string, string>;
  readonly carddArgs?: readonly string[];
  readonly mate?: Record<string, string>;
  readonly dashTokens?: readonly string[];
  readonly workerArgs?: readonly string[];
  readonly workerShell?: boolean;
  readonly remote?: boolean;
  readonly delivery?: string;
  readonly repo?: boolean;
  readonly gate?: "allowed" | "blocked";
  readonly extension?: string;
  readonly hosts?: Record<string, readonly string[]>;
  readonly roots?: Record<string, string>;
  readonly needsTrust?: boolean;
  readonly freshInstall?: boolean;
  readonly mateRoute?: (carddUrl: string) => Promise<MateRoute>;
}

function gateRemote(
  clone: string,
  remote: string,
  gate: "allowed" | "blocked",
): Record<string, string> {
  const folder = dirname(clone);
  const envrc = join(folder, ".envrc");
  const rewrite = `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.${remote}.insteadOf GIT_CONFIG_VALUE_0=gated://site\n`;
  writeFileSync(envrc, rewrite);
  const config = join(folder, "direnv-config");
  mkdirSync(config);
  const exact = gate === "allowed" ? JSON.stringify(envrc) : "";
  writeFileSync(join(config, "direnv.toml"), `[whitelist]\nexact = [${exact}]\n`);
  gitIn(clone, "remote", "set-url", "origin", "gated://site");
  return { DIRENV_CONFIG: config };
}

function commitProjectSettings(clone: string, wanted: boolean): void {
  if (!wanted) return;
  mkdirSync(join(clone, ".pi"));
  writeFileSync(join(clone, ".pi", "settings.json"), "{}\n");
  gitIn(clone, "add", ".pi/settings.json");
  gitIn(clone, "commit", "-q", "-m", "project settings");
}

function addSite(
  cardd: Cardd,
  {
    remote: withRemote = false,
    delivery = "no-mistakes",
    repo = true,
    gate,
    hosts = {},
    needsTrust,
  }: LabOptions,
): { clone: string; remote: string | undefined; env: Record<string, string> } {
  const clone = join(tempDir("fleet-clone-"), "site");
  const git = "git -c user.name=t -c user.email=t@t";
  const init = `${git} init -q -b main site && ${git} -C site commit -q --allow-empty -m init`;
  execFileSync("sh", ["-c", init], { cwd: dirname(clone) });
  commitProjectSettings(clone, needsTrust === true);
  const remote = withRemote ? addRemote(clone) : undefined;
  const env = gate === undefined || remote === undefined ? {} : gateRemote(clone, remote, gate);
  cardd.addProject(
    "site",
    remote === undefined
      ? {
          local: clone,
          flaky: clone,
          far: clone,
          ...Object.fromEntries(Object.keys(hosts).map((host) => [host, clone])),
        }
      : { local: clone },
    repo ? "acme/site" : undefined,
    delivery,
  );
  return { clone, remote, env };
}

function freshHome(): { clone: string; env: Record<string, string> } {
  const fresh = tempDir("fleet-fresh-home-");
  return {
    clone: join(fresh, ".fleet", "projects", "personal"),
    env: { HOME: fresh, FLEET_HOST_DIR: "" },
  };
}

async function startSite(
  carddEnv: Record<string, string> | undefined,
  carddArgs: readonly string[],
  site: LabOptions,
): Promise<{
  cardd: Cardd;
  clone: string;
  remote: string | undefined;
  env: Record<string, string>;
}> {
  if (site.freshInstall !== true) {
    const cardd = await Cardd.start(carddEnv, carddArgs);
    return { cardd, ...addSite(cardd, site) };
  }
  const fresh = freshHome();
  const cardd = await Cardd.start({ ...carddEnv, ...fresh.env }, carddArgs);
  return { cardd, clone: fresh.clone, remote: undefined, env: fresh.env };
}

const routeFor = (
  make: LabOptions["mateRoute"],
  carddUrl: string,
): Promise<MateRoute | undefined> =>
  make === undefined ? Promise.resolve(undefined) : make(carddUrl);

const urlFor = (route: MateRoute | undefined, carddUrl: string): string => route?.url ?? carddUrl;

export async function startDispatchLab({
  cardd: carddEnv,
  carddArgs = [],
  mate: mateEnv,
  dashTokens = [],
  workerArgs = [],
  workerShell = false,
  extension = EXTENSION,
  roots = {},
  mateRoute,
  ...site
}: LabOptions = {}): Promise<DispatchLab> {
  const checkout = resolve(dirname(extension), "..", "..", "..");
  const { cardd, clone, remote, env } = await startSite(carddEnv, carddArgs, site);
  if (dashTokens.length > 0) cardd.dashTokens(dashTokens);
  const route = await routeFor(mateRoute, cardd.url);
  const home = tempDir("fleet-home-");
  const mainToken = cardd.addLane("main", undefined, home);
  const piConfig = tempDir("herdr-pi-");
  mkdirSync(join(piConfig, "extensions"));
  execFileSync("herdr", ["integration", "install", "pi"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: piConfig },
  });
  const h = await Harness.start();
  const lab = await HerdrLab.start({
    ...h.piEnv("worker"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_ARGV_FILE: launchArgsOf(h),
    FLEET_AVOID_FILE: avoidSeenOf(h),
  });
  const mate = h.startPi(
    "main",
    {
      FLEET_URL: urlFor(route, cardd.url),
      FLEET_TOKEN: mainToken,
      FLEET_ROLE: "mate",
      ...lab.owned,
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      ...env,
      ...mateEnv,
      FLEET_PI_ARGS: JSON.stringify([
        ...h
          .piArgs(workerShell)
          .filter((arg) => !(site.needsTrust === true && arg === "--no-approve")),
        "-e",
        join(piConfig, "extensions", "herdr-agent-state.ts"),
        ...workerArgs,
      ]),
      FLEET_HOSTS: JSON.stringify({
        flaky: ["node", FLAKY, join(h.dir, "dropped")],
        far: ["node", SWITCH, join(h.dir, "far-down")],
        ...site.hosts,
      }),
      FLEET_ROOTS: JSON.stringify({ flaky: checkout, far: checkout, ...roots }),
    },
    [extension],
  );
  return { cardd, h, lab, clone, remote, mate, home, mainToken, route };
}

const stopRoute = (route: MateRoute | undefined): Promise<void> =>
  route === undefined ? Promise.resolve() : route.stop();

export async function stopDispatchLab({ lab, h, cardd, route }: DispatchLab): Promise<void> {
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop(), stopRoute(route)]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
}

export const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);
export const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
export const plan = (turns: Turn[], plans: Record<string, readonly Move[]>): Move => {
  const at = turns.findLastIndex((turn) => turn.role === "user");
  const done = turns.slice(at).filter((turn) => turn.role === "toolResult").length;
  const ask = turns[at]?.text ?? "";
  const moves = Object.entries(plans).find(([key]) => ask.includes(key))?.[1] ?? [];
  return moves[done] ?? { text: "noted" };
};
export const RESTART_REPEATED =
  "This restart key was already recorded. No new launch was attempted.";

const restartRepeatFinished = (h: Harness) =>
  h.waitFor(
    (event) =>
      event["type"] === "tool_execution_end" &&
      event["tool"] === "restart_card" &&
      event["text"] === RESTART_REPEATED,
    "the mate's repeated restart_card call to finish while the start is gated",
  );

export function repeatFinished({ route, h }: DispatchLab): Promise<unknown> {
  if (route === undefined) throw new Error("the mate's calls are not routed through a hold");
  route.release();
  return restartRepeatFinished(h);
}

export const holdRepeat = (key: string): ((carddUrl: string) => Promise<MateRoute>) => {
  return (carddUrl) => RepeatProxy.start(carddUrl, key);
};

export const mateConnected = (h: Harness) =>
  h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");

export function herdrStartRunning(lab: HerdrLab, attempt: string): boolean {
  try {
    execFileSync("pgrep", ["-f", `herdr agent start ${attempt} .*--session ${lab.name}`]);
    return true;
  } catch {
    return false;
  }
}

export const worktreesOf = (clone: string): string[] =>
  execFileSync("git", ["-C", clone, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("branch "));

export const branchesOf = (clone: string): string[] =>
  execFileSync("git", ["-C", clone, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

export const sidebarOf = async (lab: HerdrLab): Promise<string[]> =>
  records((await lab.run(["workspace", "list"]))["workspaces"]).map((each) =>
    String(each["label"]),
  );

const PANE_GONE = /"code":\s*"pane_not_found"/;

async function attemptPanes(lab: HerdrLab): Promise<{ attempt: string; pi: number | undefined }[]> {
  const panes = records((await lab.run(["pane", "list"]))["panes"]);
  const found = [];
  for (const pane of panes) {
    const attempt = /\.worktrees\/([^/]+)$/.exec(String(pane["cwd"]))?.[1];
    if (attempt === undefined) continue;
    const info = await lab
      .run(["pane", "process-info", "--pane", String(pane["pane_id"])])
      .catch((error: unknown) => {
        if (error instanceof Error && PANE_GONE.test(error.message)) return undefined;
        throw error;
      });
    if (info === undefined) continue;
    const processInfo = records([info["process_info"]])[0];
    const runsPi = records(processInfo?.["foreground_processes"]).some(
      (each) => each["argv0"] === "pi" || each["name"] === "pi",
    );
    const group = Number(processInfo?.["foreground_process_group_id"]);
    found.push({ attempt, pi: runsPi ? group : undefined });
  }
  return found;
}

export const workersOf = async (lab: HerdrLab): Promise<string[]> =>
  (await attemptPanes(lab))
    .filter((pane) => pane.pi !== undefined)
    .map((pane) => pane.attempt)
    .sort();

export async function workerGroupOf(lab: HerdrLab, attempt: string): Promise<number | undefined> {
  return (await attemptPanes(lab)).find((each) => each.attempt === attempt && each.pi !== undefined)
    ?.pi;
}
