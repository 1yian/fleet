import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  launchArgsOf,
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  workersOf,
  WORKER_WAIT_MS,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { Scratch } from "../support/scratch.ts";
import { launchdLikeHost } from "../support/tool-stubs.ts";
import { tempDir } from "../support/run-root.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const LAUNCHD_TRANSPORT = fileURLToPath(
  new URL("../support/launchd-transport.ts", import.meta.url),
);

let parts: DispatchLab | undefined;
let scratch: Scratch;
let matesOwnExtension: string;
beforeEach(() => {
  scratch = new Scratch();
  matesOwnExtension = join(scratch.root, "packages/extension/src/index.ts");
});
afterEach(async (t) => {
  if (parts !== undefined) {
    await parts.lab.printIfFailed(t);
    await stopDispatchLab(parts);
  }
  parts = undefined;
  scratch.dispose();
});

async function maverick(root: string): Promise<DispatchLab> {
  const host = launchdLikeHost();
  parts = await startDispatchLab({
    extension: matesOwnExtension,
    hosts: { maverick: ["node", LAUNCHD_TRANSPORT, host.system] },
    roots: { maverick: root },
    mate: { FLEET_TOOL_DIRS: host.homebrew },
  });
  const { h } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "maverick",
        task: "fix the scrollbar",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  await mateConnected(h);
  rmSync(matesOwnExtension);
  return parts;
}

function checkoutWithExtension(source: string): string {
  const root = tempDir("fleet-destination-");
  mkdirSync(join(root, "packages/extension/src"), { recursive: true });
  writeFileSync(join(root, "packages/extension/src/index.ts"), source);
  return root;
}

test("a worker started on a host whose commands run with a launchd-like PATH connects, with the extension of that host's checkout and not the mate's own path", async () => {
  const { h, lab, mate } = await maverick(REPO);
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "fixed" } }), "worker");
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(2, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "Dispatched c-1-a1 on maverick, branch c-1-a1.");
  const worker = await h.waitForCall(0, "worker", WORKER_WAIT_MS);
  assert.equal(
    lastUser(worker),
    "[fleet] main on c-1 one-scrollbar: fix the scrollbar\n\nDelivery: no-mistakes",
  );
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);
  const woken = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.match(lastUser(woken) ?? "", /^\[fleet\] c-1 one-scrollbar done: fixed/);
});

test("a dispatch to a host whose checkout has no extension refuses before it creates anything, and names the root it looked in", async () => {
  const missing = join(tempDir("fleet-destination-"), "no-checkout");
  const { h, clone, mate } = await maverick(missing);
  mate.prompt("ship the scrollbar fix");

  const result = toolResults(await h.waitForCall(2, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  assert.match(result, /no fleet extension to start a worker with on maverick/);
  assert.ok(result.includes(`${missing} has no packages/extension/src/index.ts`));
  assert.match(result, /Set roots\.maverick in this lane's config\/lane\.json/);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
});

async function mateHeard(h: DispatchLab["h"], pattern: RegExp): Promise<string> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const turns = h.callsOf("mate").flat();
    const found = turns.find((turn) => pattern.test(turn.text));
    if (found !== undefined) return found.text;
    if (Date.now() > deadline) throw new Error(`the mate never heard ${String(pattern)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a worker whose extension fails to load on the host is reported with the last lines of its pane, and never its token", async () => {
  const root = checkoutWithExtension('throw new Error("boom from the destination extension");\n');
  const { h, lab, mate } = await maverick(root);
  h.onModel(() => ({ text: "noted" }), "mate");
  mate.prompt("ship the scrollbar fix");

  const result = await mateHeard(h, /Pi is not running in pane/);
  assert.match(
    result,
    /Pi is not running in pane \S+ on maverick after c-1-a1 was started in it, so the worker never connected\./,
  );
  assert.match(result, /boom from the destination extension/);
  const launched = readFileSync(launchArgsOf(h), "utf8").split("\n");
  const token = launched
    .find((arg) => arg.startsWith("--fleet-token="))
    ?.slice("--fleet-token=".length);
  assert.ok(token !== undefined && token !== "", "the worker was launched without a token");
  assert.ok(!result.includes(token), "the report carries the worker token");
  assert.ok(!result.includes("--fleet-bws="), "the report carries the bws settings");
  assert.deepEqual(await workersOf(lab), []);
});

test("close on a host whose commands run with a launchd-like PATH compresses and keeps the unlanded work", async () => {
  const { h, clone, mate } = await maverick(REPO);
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "the design changed", landed: false } }),
    "mate",
  );
  h.onModel(() => {
    const tree = `${clone}.worktrees/c-1-a1`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    git("switch", "-q", "-c", "feat/one-scrollbar");
    writeFileSync(join(tree, "committed.txt"), "one\n");
    git("add", "committed.txt");
    git("commit", "-q", "-m", "work in progress");
    writeFileSync(join(tree, "staged.txt"), "two\n");
    git("add", "staged.txt");
    writeFileSync(join(tree, "committed.txt"), "one\nchanged\n");
    writeFileSync(join(tree, "untracked.txt"), "three\n");
    return { tool: "report", args: { status: "blocked", text: "the design is unclear" } };
  }, "worker");
  mate.prompt("ship the scrollbar fix");

  const archive = `${clone}.archive/c-1-a1.tar.zst`;
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), `c-1 is dropped. Unlanded work is archived in maverick:${archive}.`);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);

  execFileSync("zstd", ["-t", "-q", archive]);
  const out = tempDir("fleet-unpack-");
  execFileSync("sh", ["-c", `zstd -dc '${archive}' | tar -xf - -C '${out}'`]);
  const unpacked = join(out, "c-1-a1");
  assert.deepEqual(
    readdirSync(unpacked).sort(),
    ["commits.bundle", "manifest.json", "staged.patch", "unstaged.patch", "untracked.tar"].sort(),
  );
  execFileSync("git", ["-C", clone, "bundle", "verify", join(unpacked, "commits.bundle")]);
  assert.match(readFileSync(join(unpacked, "staged.patch"), "utf8"), /staged\.txt/);
  assert.match(readFileSync(join(unpacked, "unstaged.patch"), "utf8"), /\+changed/);
  assert.match(
    execFileSync("tar", ["-tf", join(unpacked, "untracked.tar")], { encoding: "utf8" }),
    /untracked\.txt/,
  );
});
