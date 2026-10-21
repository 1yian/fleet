import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRecord } from "../support/json.ts";

const RUNNER = fileURLToPath(new URL("../support/orphan-runner.ts", import.meta.url));
const WAIT_MS = 30_000;
const PI_COMMAND = /^pi\b|node .*\/pi\b/;

interface Running {
  readonly pid: number;
  readonly command: string;
}

const ps = (...args: string[]): string => {
  try {
    return execFileSync("ps", args, { encoding: "utf8" });
  } catch {
    return "";
  }
};

const commandOf = (pid: number): string => ps("-o", "command=", "-p", String(pid)).trim();

function descendantsOf(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of ps("-A", "-o", "pid=,ppid=").split("\n")) {
    const [pid = 0, parent = 0] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  for (let queue = [root]; queue.length > 0;) {
    queue = queue.flatMap((pid) => children.get(pid) ?? []);
    found.push(...queue);
  }
  return found;
}

function pgrep(pattern: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "")
      .map(Number);
  } catch {
    return [];
  }
}

const alive = ({ pid, command }: Running): boolean => commandOf(pid) === command;

function labListed(lab: string): boolean {
  const listing = execFileSync("herdr", ["session", "list"], { encoding: "utf8" });
  return listing.split("\n").some((line) => line.trim().split(/\s+/)[0] === lab);
}

async function readyLine(runner: ReturnType<typeof spawn>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let out = "";
    runner.stderr?.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    runner.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n").find((each) => each.startsWith('{"ready"'));
      if (line !== undefined) resolve(parseRecord(line));
    });
    runner.once("exit", () => {
      reject(new Error(`the runner exited before it was ready: ${out}`));
    });
  });
}

function killIfAlive(each: Running): void {
  if (!alive(each)) return;
  try {
    process.kill(each.pid, "SIGKILL");
  } catch {
    return;
  }
}

function removeLab(lab: string): void {
  for (const verb of ["stop", "delete"]) {
    try {
      execFileSync("herdr", ["session", verb, lab], { stdio: "ignore" });
    } catch {
      process.stderr.write(`could not ${verb} herdr session ${lab}\n`);
    }
  }
}

test("SIGKILL of a test runner removes its cardd, direct Pi, shell-owned Pi, pane jobs, and herdr lab session", async (t) => {
  const runner = spawn("node", [RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    runner.kill("SIGKILL");
  });
  const exited = new Promise((resolve) => runner.once("exit", resolve));
  const ready = await readyLine(runner).catch((error: unknown) => {
    runner.kill("SIGKILL");
    throw error;
  });
  const runnerPid = Number(runner.pid);
  const sleeper = String(ready["sleeper"]);
  for (const deadline = Date.now() + WAIT_MS; pgrep(sleeper).length === 0;) {
    assert.ok(Date.now() < deadline, `the pane never ran ${sleeper}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const known = [
    ...descendantsOf(runnerPid).filter((pid) => !commandOf(pid).includes("reaper.ts")),
    ...pgrep(sleeper),
  ];
  const running: Running[] = [...new Set(known)]
    .map((pid) => ({ pid, command: commandOf(pid) }))
    .filter((each) => each.command !== "");
  const kinds = [
    /cardd\/src\/main\.ts serve/,
    /^herdr server/,
    PI_COMMAND,
    new RegExp(`^${sleeper}`),
  ];
  const missing = kinds.filter((kind) => !running.some((each) => kind.test(each.command)));
  const panePi = running.find((each) => each.pid === ready["panePi"]);
  const lab = String(ready["lab"]);
  const listedBefore = labListed(lab);
  runner.kill("SIGKILL");
  await exited;

  const deadline = Date.now() + WAIT_MS;
  let left = running.filter(alive);
  let listedAfter = labListed(lab);
  while ((left.length > 0 || listedAfter) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    left = left.filter(alive);
    listedAfter = labListed(lab);
  }
  const dirs = Array.isArray(ready["dirs"]) ? ready["dirs"].map(String) : [];
  try {
    assert.ok(panePi, "a real Pi was running in the lab's shell before SIGKILL");
    assert.match(panePi.command, PI_COMMAND);
    assert.equal(
      running.filter((each) => PI_COMMAND.test(each.command)).length,
      2,
      "both a direct Pi and a pane-owned Pi were running before SIGKILL",
    );
    assert.equal(listedBefore, true, "the lab session was registered before SIGKILL");
    assert.deepEqual(
      missing.map(String),
      [],
      `the runner started ${running.map((each) => each.command).join(" | ")}`,
    );
    assert.deepEqual(
      left.map((each) => each.command),
      [],
      "processes the runner started outlived it",
    );
    assert.equal(listedAfter, false, "the runner left a herdr lab session record behind");
  } finally {
    runner.stdout.destroy();
    runner.stderr.destroy();
    if (left.length > 0 || listedAfter) removeLab(lab);
    for (const each of left) killIfAlive(each);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
