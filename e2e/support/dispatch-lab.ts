// A dispatch lab (spec sections 11.2 and 25, test 8): cardd, the scripted fake
// model, a herdr lab session, a git clone of project "site", and a real mate Pi
// with the fleet extension that dispatches real worker Pis into the lab.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cardd } from "./cardd.ts";
import { Harness, type Pi, type Turn } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";

/** herdr starts each worker Pi cold, which can take tens of seconds on a busy CI runner. */
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
  readonly mate: Pi;
  readonly home: string;
}

/** The file where the lab's worker launches record their arguments. */
export const launchArgsOf = (h: Harness): string => join(h.dir, "worker-args");

/** Variations of the lab: cardd's environment, and extra arguments for every worker's Pi. */
export interface LabOptions {
  readonly cardd?: Record<string, string>;
  readonly workerArgs?: readonly string[];
}

export async function startDispatchLab({
  cardd: carddEnv,
  workerArgs = [],
}: LabOptions = {}): Promise<DispatchLab> {
  const cardd = await Cardd.start(carddEnv);
  const home = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const mainToken = cardd.addLane("main", undefined, home);
  const clone = join(mkdtempSync(join(tmpdir(), "fleet-clone-")), "site");
  const git = "git -c user.name=t -c user.email=t@t";
  const init = `${git} init -q -b main site && ${git} -C site commit -q --allow-empty -m init`;
  execFileSync("sh", ["-c", init], { cwd: dirname(clone) });
  cardd.addProject("site", { local: clone, flaky: clone, far: clone });
  const h = await Harness.start();
  const lab = await HerdrLab.start({
    ...h.piEnv("worker"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_ARGV_FILE: launchArgsOf(h),
  });
  const mate = h.startPi(
    "main",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: mainToken,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      FLEET_PI_ARGS: JSON.stringify([...h.piArgs(), "-e", EXTENSION, ...workerArgs]),
      FLEET_HOSTS: JSON.stringify({
        flaky: ["node", FLAKY, join(h.dir, "dropped")],
        far: ["node", SWITCH, join(h.dir, "far-down")],
      }),
    },
    [EXTENSION],
  );
  return { cardd, h, lab, clone, mate, home };
}

/** Stops everything even if one part fails, so no process outlives the test. */
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

/** The clone's worktrees, by branch. */
export const worktreesOf = (clone: string): string[] =>
  execFileSync("git", ["-C", clone, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("branch "));

export const branchesOf = (clone: string): string[] =>
  execFileSync("git", ["-C", clone, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

/** The workspace labels in herdr's sidebar, top to bottom. */
export const sidebarOf = async (lab: HerdrLab): Promise<string[]> =>
  records((await lab.run(["workspace", "list"]))["workspaces"]).map((each) =>
    String(each["label"]),
  );

/** Each pane in a worktree: its attempt, and the foreground group of the Pi that runs there, if one does. */
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

/** The attempts whose pane runs a Pi: the live workers. A job tab in the same worktree does not count. */
export const workersOf = async (lab: HerdrLab): Promise<string[]> =>
  (await attemptPanes(lab))
    .filter((pane) => pane.pi !== undefined)
    .map((pane) => pane.attempt)
    .sort();

/** The foreground process group of an attempt's worker Pi, to kill the worker in a test. */
export async function workerGroupOf(lab: HerdrLab, attempt: string): Promise<number | undefined> {
  return (await attemptPanes(lab)).find((each) => each.attempt === attempt && each.pi !== undefined)
    ?.pi;
}
