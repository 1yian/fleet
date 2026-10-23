import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cardd } from "./cardd.ts";
import { Harness, type Pi, type Turn } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";
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
}

export const launchArgsOf = (h: Harness): string => join(h.dir, "worker-args");
export const avoidSeenOf = (h: Harness): string => join(h.dir, "worker-avoid");

export interface LabOptions {
  readonly cardd?: Record<string, string>;
  readonly mate?: Record<string, string>;
  readonly dashTokens?: readonly string[];
  readonly workerArgs?: readonly string[];
  readonly remote?: boolean;
  readonly delivery?: string;
  readonly repo?: boolean;
  readonly gate?: "allowed" | "blocked";
  readonly extension?: string;
}

function gateRemote(
  clone: string,
  remote: string,
  gate: "allowed" | "blocked",
): Record<string, string> {
  const folder = realpathSync(dirname(clone));
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

function addSite(
  cardd: Cardd,
  { remote: withRemote = false, delivery = "no-mistakes", repo = true, gate }: LabOptions,
): { clone: string; remote: string | undefined; env: Record<string, string> } {
  const clone = join(tempDir("fleet-clone-"), "site");
  const git = "git -c user.name=t -c user.email=t@t";
  const init = `${git} init -q -b main site && ${git} -C site commit -q --allow-empty -m init`;
  execFileSync("sh", ["-c", init], { cwd: dirname(clone) });
  const remote = withRemote ? addRemote(clone) : undefined;
  const env = gate === undefined || remote === undefined ? {} : gateRemote(clone, remote, gate);
  cardd.addProject(
    "site",
    remote === undefined ? { local: clone, flaky: clone, far: clone } : { local: clone },
    repo ? "acme/site" : undefined,
    delivery,
  );
  return { clone, remote, env };
}

export async function startDispatchLab({
  cardd: carddEnv,
  mate: mateEnv,
  dashTokens = [],
  workerArgs = [],
  extension = EXTENSION,
  ...site
}: LabOptions = {}): Promise<DispatchLab> {
  const cardd = await Cardd.start(carddEnv);
  if (dashTokens.length > 0) cardd.dashTokens(dashTokens);
  const home = tempDir("fleet-home-");
  const mainToken = cardd.addLane("main", undefined, home);
  const { clone, remote, env } = addSite(cardd, site);
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
      FLEET_URL: cardd.url,
      FLEET_TOKEN: mainToken,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      ...env,
      ...mateEnv,
      FLEET_PI_ARGS: JSON.stringify([...h.piArgs(), "-e", extension, ...workerArgs]),
      FLEET_HOSTS: JSON.stringify({
        flaky: ["node", FLAKY, join(h.dir, "dropped")],
        far: ["node", SWITCH, join(h.dir, "far-down")],
      }),
    },
    [extension],
  );
  return { cardd, h, lab, clone, remote, mate, home, mainToken };
}

export async function stopDispatchLab({ lab, h, cardd }: DispatchLab): Promise<void> {
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
}

export const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);
export const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
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

async function attemptPanes(lab: HerdrLab): Promise<{ attempt: string; pi: number | undefined }[]> {
  const panes = records((await lab.run(["pane", "list"]))["panes"]);
  const found = [];
  for (const pane of panes) {
    const attempt = /\.worktrees\/([^/]+)$/.exec(String(pane["cwd"]))?.[1];
    if (attempt === undefined) continue;
    const info = await lab.run(["pane", "process-info", "--pane", String(pane["pane_id"])]);
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
