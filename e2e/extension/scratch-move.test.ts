import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { tempDir } from "../support/run-root.ts";
import { fleet, listing, setHostSettings } from "../support/scratch-files.ts";

const SEEDED = [
  "notes/",
  "notes/deep/",
  "notes/deep/log.txt",
  "report.md",
  "tool.sh",
  "via-link.txt",
];

let home: string;
let oldTmp: string;
let disk: string;
let old: string;
let holder: ChildProcess | undefined;

const hostEnv = (): Record<string, string> => ({
  HOME: home,
  FLEET_HOST_DIR: "",
  FLEET_TMP_SOURCE_DIR: oldTmp,
});

const move = (env: Record<string, string> = {}): string =>
  fleet(["scratch", "--move", "1"], { ...hostEnv(), ...env }).trim();

beforeEach(() => {
  home = tempDir("fleet-host-home-");
  oldTmp = tempDir("fleet-old-tmp-");
  disk = join(tempDir("fleet-disk-"), "kept");
  old = join(oldTmp, "fleet-c-1");
  mkdirSync(join(old, "notes", "deep"), { recursive: true });
  writeFileSync(join(old, "report.md"), "the evidence of card 1\n");
  writeFileSync(join(old, "notes", "deep", "log.txt"), "a deep file\n");
  writeFileSync(join(old, "tool.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  symlinkSync("report.md", join(old, "via-link.txt"));
  setHostSettings(join(home, ".fleet"), { tmpScratch: disk });
});

afterEach(() => {
  holder?.kill("SIGKILL");
  holder = undefined;
});

const holdFolder = async (): Promise<void> => {
  holder = spawn("sleep", ["600"], { cwd: join(old, "notes"), stdio: "ignore" });
  await new Promise((resolve, reject) => {
    holder?.once("spawn", resolve);
    holder?.once("error", reject);
  });
};

const shimmed = (tool: string, before: string): string => {
  const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
  const dir = tempDir("fleet-shim-");
  writeFileSync(join(dir, tool), `#!/bin/sh\n${before}\nexec ${real} "$@"\n`, { mode: 0o755 });
  return `${dir}:${process.env["PATH"] ?? ""}`;
};

const parkedOf = (): string => {
  const name = readdirSync(oldTmp).find((each) => each.startsWith("fleet-c-1.moved-"));
  assert.notEqual(name, undefined, "the renamed original is kept");
  return join(oldTmp, name ?? "");
};

const isRealFolder = (path: string): boolean => lstatSync(path).isDirectory();

test("the manual command moves the card's /tmp scratch to disk, leaves a symlink that resolves to the same files, and deletes nothing", () => {
  const before = listing(old);
  const result = move();

  const moved = join(disk, "fleet-c-1");
  assert.equal(result, `${old} moved to ${moved}`);
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

test("a folder that a live process holds is left alone and named, the move happens once the process is gone", async () => {
  await holdFolder();
  const result = move();

  assert.equal(
    result,
    `${old} stays in place: held by a live process (pid ${String(holder?.pid)})`,
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

test("moving again, by a repeat or on a path that is already a symlink, changes nothing", () => {
  move();
  const moved = join(disk, "fleet-c-1");
  const before = listing(moved);

  assert.equal(fleet(["scratch", "--move", "1"], hostEnv()).trim(), "nothing to move");
  assert.equal(fleet(["scratch", "--move", "1"], hostEnv()).trim(), "nothing to move");

  assert.equal(readlinkSync(old), moved);
  assert.deepEqual(listing(moved), before);
  assert.deepEqual(listing(disk), ["fleet-c-1/", ...before.map((name) => `fleet-c-1/${name}`)]);
});

test(
  "a folder that cannot be replaced is left in place and named",
  { skip: process.getuid?.() === 0 },
  () => {
    const locked = join(old, "notes", "deep");
    chmodSync(locked, 0o500);
    try {
      const result = move();

      assert.match(
        result,
        new RegExp(
          `^${old} stays in place: holds a file or folder this user cannot replace \\(${locked}\\)$`,
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

test("a copy left behind by an earlier run with the same size and time but other bytes is not trusted", () => {
  const when = new Date("2026-01-02T03:04:05Z");
  const stale = join(disk, ".moving-fleet-c-1");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "report.md"), "the evidence of card 2\n");
  utimesSync(join(stale, "report.md"), when, when);
  utimesSync(join(old, "report.md"), when, when);

  const result = move();

  const moved = join(disk, "fleet-c-1");
  assert.equal(result, `${old} moved to ${moved}`);
  assert.equal(readFileSync(join(moved, "report.md"), "utf8"), "the evidence of card 1\n");
  assert.deepEqual(listing(old), SEEDED);
});

test("a process that enters the folder just before it is renamed aside is found there, and the folder goes back", () => {
  const marks = tempDir("fleet-marks-");
  const pidFile = join(marks, "holder.pid");
  const ready = join(marks, "holder.ready");
  const enter = `case " $* " in *" ${old} "*) [ -e "${pidFile}" ] || { ( cd "${old}/notes" && : > "${ready}" && exec sleep 600 ) </dev/null >/dev/null 2>&1 3>&- & echo $! > "${pidFile}"; while [ ! -e "${ready}" ]; do :; done; } ;; esac`;
  try {
    const result = move({ PATH: shimmed("node", enter) });

    const pid = readFileSync(pidFile, "utf8").trim();
    assert.equal(result, `${old} stays in place: held by a live process (pid ${pid})`);
    assert.equal(isRealFolder(old), true);
    assert.deepEqual(listing(old), SEEDED);
    assert.deepEqual(
      listing(oldTmp).filter((name) => name.includes(".moved-")),
      [],
    );
    assert.equal(existsSync(join(disk, "fleet-c-1")), false);
  } finally {
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  }
});

test("a host whose /proc cannot be read skips the move, because an empty scan is not the same as nobody holding it", () => {
  const deny = `case "$1" in /proc/*/fd) echo "ls: cannot open directory '$1': Permission denied" >&2; exit 2 ;; esac`;
  const result = move({ PATH: shimmed("ls", deny) });

  assert.equal(
    result,
    `${old} stays in place: cannot tell whether a process holds it (no readable /proc and no lsof)`,
  );
  assert.equal(isRealFolder(old), true);
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(existsSync(join(disk, "fleet-c-1")), false);
});

test("when a late writer makes the old path again and the second copy fails, the original is kept beside it and named, not nested inside it", () => {
  const late = `[ -e "${old}" ] || { mkdir "${old}" && echo "a late write" > "${old}/late.txt"; echo "write failed: No space left on device" >&2; exit 11; }`;
  const result = move({ PATH: shimmed("rsync", late) });

  const kept = parkedOf();
  assert.equal(
    result,
    `${old} stays in place: it changed while it was copied, and ${old} is taken, so the original is kept as ${kept}`,
  );
  assert.deepEqual(listing(old), ["late.txt"]);
  assert.deepEqual(listing(kept), SEEDED);
  assert.equal(existsSync(join(disk, "fleet-c-1")), false);
});

test("when a late writer makes the old path again before the link, the link does not go inside it and the original stays", () => {
  const moved = join(disk, "fleet-c-1");
  const late = `case " $* " in *" ${moved} ${old} "*) mkdir "${old}" && echo "a late write" > "${old}/late.txt" ;; esac`;
  const result = move({ PATH: shimmed("node", late) });

  const kept = parkedOf();
  assert.equal(
    result,
    `${old} moved to ${moved} (the path was made again during the move, so the original stays in ${kept})`,
  );
  assert.deepEqual(listing(old), ["late.txt"]);
  assert.deepEqual(listing(kept), SEEDED);
  assert.deepEqual(listing(moved), SEEDED);
});

test("a stop signal while the original is renamed aside puts it back, and the move names it", () => {
  const marks = tempDir("fleet-marks-");
  const stop = `[ -e "${old}" ] || [ -e "${marks}/stopped" ] || { : > "${marks}/stopped"; kill -TERM "$PPID"; }`;
  const result = move({ PATH: shimmed("rsync", stop) });

  assert.equal(result, `${old} stays in place: it was stopped before it finished`);
  assert.equal(isRealFolder(old), true);
  assert.deepEqual(listing(old), SEEDED);
  assert.deepEqual(
    listing(oldTmp).filter((name) => name.includes(".moved-")),
    [],
  );
  assert.equal(existsSync(join(disk, "fleet-c-1")), false);
});
