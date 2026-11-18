import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "node:test";
import { Cardd } from "./cardd.ts";
import { WORKER_WAIT_MS } from "./dispatch-lab.ts";
import { Harness, type Pi, type Turn } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { git } from "./remote.ts";
import { Scratch } from "./scratch.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("./shell-tool.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
export const hostScratch = (): string => join(process.env["FLEET_HOST_DIR"] ?? "", "scratch");

export let scratch: Scratch;
export let cardd: Cardd;
export let h: Harness;
export let lab: HerdrLab;
let mate: Pi;
export let report: string;
export let tree: string;

beforeEach(async () => {
  rmSync(hostScratch(), { recursive: true, force: true });
  scratch = new Scratch();
  cardd = await Cardd.start();
  h = await Harness.start();
  report = join(hostScratch(), "c-1", "operation.md");
  tree = `${scratch.root}.worktrees/c-1-a1`;
  const token = cardd.addLane("main", undefined, scratch.root);
  cardd.addProject("fleet", { local: scratch.root }, undefined, "no-mistakes");
  cardd.yolo("fleet");
  lab = await HerdrLab.start({ ...h.piEnv("worker"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
  mate = h.startPi(
    "main",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      FLEET_PI_ARGS: JSON.stringify([...h.piArgs(), "-e", SHELL]),
    },
    [EXTENSION],
  );
});

afterEach(async (t) => {
  await lab.printIfFailed(t);
  await lab.stop();
  await h.stop();
  await cardd.stop();
  scratch.dispose();
});

export function dispatchOperation(): void {
  h.onModel(() => {
    git(scratch.root, "remote", "add", "origin", join(scratch.parent, "unreachable.git"));
    return { tool: "board", args: {} };
  }, "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Record the approved operation",
        name: "approved-operation",
        kind: "ship",
        project: "fleet",
        intent: "Run the approved operation without code changes",
        host: "local",
        task: "Record the operation evidence.",
        delivery: "ops",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
}

export function written(path: string): { tool: string; args: Record<string, string> } {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    "# Operation\n\nThe approved action completed. Observed state: ready. No project changes.\n",
  );
  return {
    tool: "report",
    args: {
      status: "done",
      text: "Operation complete; the evidence report is attached",
      evidence: path,
    },
  };
}

export async function start(): Promise<void> {
  await h.waitFor((event) => event["type"] === "fleet_connected", "mate connected");
  mate.prompt("Run the approved operation.");
}

export const finished = (call: number): Promise<Turn[]> =>
  h.waitForCall(call, "mate", WORKER_WAIT_MS);

export const closedFolders = (): string[] =>
  readdirSync(hostScratch()).filter((name) => name.startsWith("c-1.closed-"));

const LAUNCHER = `
const { spawn } = require("node:child_process");
const [cwd, script] = process.argv.slice(2);
spawn("sh", ["-c", script], { cwd, detached: true, stdio: "ignore" }).unref();
`;

export function startWriter(onTerm: string): { tool: string; args: { command: string } } {
  const launcher = join(h.dir, "launch.cjs");
  const pidFile = join(h.dir, "writer.pid");
  writeFileSync(launcher, LAUNCHER);
  const script = `echo $$ > "${pidFile}"; trap "${onTerm}; exit 0" TERM; while :; do sleep 0.05; done`;
  const wait = `i=0; while [ ! -s "${pidFile}" ]; do i=$((i+1)); [ $i -gt 100 ] && exit 1; sleep 0.1; done`;
  return {
    tool: "bash",
    args: { command: `node "${launcher}" "$PWD" '${script}'\n${wait}` },
  };
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function archivedUntracked(archive: string, file: string): string {
  const packed = execFileSync("zstd", ["-dc", archive]);
  const untracked = execFileSync("tar", ["-xOf", "-", "c-1-a1/untracked.tar"], { input: packed });
  return execFileSync("tar", ["-xOf", "-", file], { input: untracked, encoding: "utf8" });
}
