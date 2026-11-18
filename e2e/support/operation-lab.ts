import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.ext.allow",
      GIT_CONFIG_VALUE_0: "always",
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

const originLog = (): string => join(h.dir, "origin-calls.log");

export const originCalls = (): string =>
  existsSync(originLog()) ? readFileSync(originLog(), "utf8") : "";

export function dispatchOperation(): void {
  h.onModel(() => {
    const script = join(h.dir, "origin.sh");
    writeFileSync(script, `#!/bin/sh\necho "$@" >> "${originLog()}"\nexit 1\n`, { mode: 0o755 });
    git(scratch.root, "remote", "add", "origin", `ext::${script} %S`);
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
