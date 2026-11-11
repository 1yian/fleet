import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { tempDir } from "../support/run-root.ts";
import { DISPATCH, fleet, listing } from "../support/scratch-files.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const SEEDED = [
  "notes/",
  "notes/deep/",
  "notes/deep/log.txt",
  "report.md",
  "tool.sh",
  "via-link.txt",
];

let parts: DispatchLab;
let home: string;
let oldTmp: string;
let disk: string;
let old: string;
let holder: ChildProcess | undefined;

const hostEnv = (): Record<string, string> => ({
  HOME: home,
  FLEET_HOST_DIR: "",
  FLEET_TMP_SOURCE_DIR: oldTmp,
  FLEET_TMP_SCRATCH_DIR: disk,
});

async function startLab(hostOverrides: Record<string, string>): Promise<void> {
  const config = process.env["XDG_CONFIG_HOME"] ?? join(process.env["HOME"] ?? "", ".config");
  parts = await startDispatchLab({
    workerArgs: ["-e", SHELL],
    mate: { ...hostEnv(), ...hostOverrides, XDG_CONFIG_HOME: config },
  });
  parts.cardd.yolo("site");
}

beforeEach(async () => {
  home = tempDir("fleet-host-home-");
  oldTmp = tempDir("fleet-old-tmp-");
  disk = join(tempDir("fleet-disk-"), "kept");
  old = join(oldTmp, "fleet-c-1");
  mkdirSync(join(old, "notes", "deep"), { recursive: true });
  writeFileSync(join(old, "report.md"), "the evidence of card 1\n");
  writeFileSync(join(old, "notes", "deep", "log.txt"), "a deep file\n");
  writeFileSync(join(old, "tool.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  symlinkSync("report.md", join(old, "via-link.txt"));
  await startLab({});
});

afterEach(async () => {
  holder?.kill("SIGKILL");
  holder = undefined;
  await stopDispatchLab(parts);
});

async function closeCard(): Promise<string> {
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("run the tests");
  return toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
}

const holdFolder = async (): Promise<void> => {
  holder = spawn("sleep", ["600"], { cwd: join(old, "notes"), stdio: "ignore" });
  await new Promise((resolve, reject) => {
    holder?.once("spawn", resolve);
    holder?.once("error", reject);
  });
};

const isRealFolder = (path: string): boolean => lstatSync(path).isDirectory();

test("close moves the card's /tmp scratch to disk, leaves a symlink that resolves to the same files, and deletes nothing", async () => {
  const before = listing(old);
  const result = await closeCard();

  const moved = join(disk, "fleet-c-1");
  assert.equal(result, `c-1 is done. Scratch moved off /tmp: local:${old} moved to ${moved}.`);
  assert.deepEqual(before, SEEDED);
  assert.equal(lstatSync(old).isSymbolicLink(), true);
  assert.equal(readlinkSync(old), moved);
  assert.equal(realpathSync(old), realpathSync(moved));
  assert.equal(isRealFolder(moved), true);
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(readFileSync(join(old, "report.md"), "utf8"), "the evidence of card 1\n");
  assert.equal(readFileSync(join(old, "notes", "deep", "log.txt"), "utf8"), "a deep file\n");
  assert.equal(readlinkSync(join(moved, "via-link.txt")), "report.md");
  assert.equal(lstatSync(join(moved, "tool.sh")).mode & 0o777, 0o755);
  assert.deepEqual(
    listing(disk).filter((name) => name.startsWith(".moving")),
    [],
    "no half-made copy stays beside the moved folder",
  );
  assert.deepEqual(
    listing(oldTmp).filter((name) => name.includes(".moved-")),
    [],
    "the renamed original is gone once the copy is in place",
  );
});

test("with no folder set, the scratch goes under the host's fleet folder", async () => {
  await stopDispatchLab(parts);
  await startLab({ FLEET_TMP_SCRATCH_DIR: "" });
  const result = await closeCard();

  const moved = join(home, ".fleet", "tmp-scratch", "fleet-c-1");
  assert.match(result, /Scratch moved off \/tmp: /);
  assert.equal(readlinkSync(old), moved);
  assert.deepEqual(listing(old), SEEDED);
});

test("a folder that a live process holds is left alone and named, close still succeeds, and the move happens once the process is gone", async () => {
  await holdFolder();
  const result = await closeCard();

  assert.equal(
    result,
    `c-1 is done. Scratch left in /tmp: local:${old} stays in place: held by a live process (pid ${String(holder?.pid)}).`,
  );
  assert.equal(isRealFolder(old), true);
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(existsSync(join(disk, "fleet-c-1")), false);

  holder?.kill("SIGKILL");
  await new Promise((resolve) => holder?.once("exit", resolve));
  assert.equal(
    fleet(["scratch", "--move", "1"], hostEnv()).trim(),
    `${old} moved to ${join(disk, "fleet-c-1")}`,
  );
  assert.equal(lstatSync(old).isSymbolicLink(), true);
  assert.deepEqual(listing(old), SEEDED);
});

test("moving again, by a repeat or on a path that is already a symlink, changes nothing", async () => {
  await closeCard();
  const moved = join(disk, "fleet-c-1");
  const before = listing(moved);

  assert.equal(fleet(["scratch", "--move", "1"], hostEnv()).trim(), "nothing to move");
  assert.equal(fleet(["scratch", "--move", "1"], hostEnv()).trim(), "nothing to move");

  assert.equal(readlinkSync(old), moved);
  assert.deepEqual(listing(moved), before);
  assert.deepEqual(listing(disk), ["fleet-c-1/", ...before.map((name) => `fleet-c-1/${name}`)]);
});

test(
  "a folder that cannot be replaced is left in place and named, and close does not fail",
  { skip: process.getuid?.() === 0 },
  async () => {
    const locked = join(old, "notes", "deep");
    chmodSync(locked, 0o500);
    try {
      const result = await closeCard();

      assert.match(
        result,
        new RegExp(
          `^c-1 is done\\. Scratch left in /tmp: local:${old} stays in place: holds a file or folder this user cannot replace \\(${locked}\\)\\.$`,
        ),
      );
      assert.equal(isRealFolder(old), true);
      assert.deepEqual(listing(old), SEEDED);
      assert.equal(existsSync(join(disk, "fleet-c-1")), false);
    } finally {
      chmodSync(locked, 0o700);
    }
  },
);
