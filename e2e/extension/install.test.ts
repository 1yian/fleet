import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { parseRecord } from "../support/json.ts";
import { git } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";
import { configureMain, Scratch } from "../support/scratch.ts";
import { pathWithout } from "../support/tool-stubs.ts";

const HOST = hostname();
const ZONE = "America/Chicago";
const FIRST = "2026-11-19T08:47:26-06:00";
const SECOND = "2026-11-20T09:00:00-06:00";
const GO_FIX =
  "Fix: install Go 1.25 or later (brew install go, or apt install golang-go), then run fleet install again";
const PI_TIERS = "git:github.com/1yian/pi-tiers";

let cardd: Cardd;
let scratch: Scratch;
let home: string;
let piDir: string;
let goDir: string;
let repo: string;

function wrapper(dir: string, name: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  const target = fileURLToPath(new URL(`../support/${script}`, import.meta.url));
  writeFileSync(join(dir, name), `#!/bin/sh\nexec node "${target}" "$@"\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}

function commitAt(when: string): string {
  writeFileSync(join(repo, "cmd", "no-mistakes", `${when}.go`), "package main\n");
  git(repo, "add", "-A");
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", when],
    { env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } },
  );
  return git(repo, "rev-parse", "--short=8", "HEAD");
}

beforeEach(async () => {
  cardd = await Cardd.start();
  scratch = new Scratch();
  configureMain(scratch, cardd.url, cardd.addLane("main"));
  home = tempDir("home-");
  piDir = wrapper(tempDir("fake-pi-"), "pi", "fake-pi.ts");
  goDir = wrapper(tempDir("fake-go-"), "go", "fake-go.ts");
  repo = join(tempDir("fork-"), "no-mistakes");
  mkdirSync(join(repo, "cmd", "no-mistakes"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
});
afterEach(async () => {
  await cardd.stop();
  scratch.dispose();
});

const agentDir = (): string => join(home, ".pi", "agent");
const nmHome = (): string => join(home, ".no-mistakes");
const target = (): string => join(home, ".local", "bin", "no-mistakes");
const template = (name: string): string =>
  join(realpathSync(scratch.root), "packages", "extension", "templates", name);
const utc = (iso: string): string => new Date(iso).toISOString().replace(".000Z", "Z");
const version = (commit: string, when: string): string =>
  `no-mistakes version fork-${commit} (${commit}) ${utc(when)}\n`;

interface Run {
  readonly status: number | null;
  readonly out: string[];
  readonly err: string[];
}

function install(path: string, args: readonly string[] = [], ahead = ""): Run {
  const done = spawnSync("node", [scratch.launch, "install", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TZ: ZONE,
      PI_CODING_AGENT_DIR: agentDir(),
      NM_HOME: nmHome(),
      FAKE_PI_STATE: join(home, "pi-packages"),
      FLEET_NO_MISTAKES_REPO: repo,
      PATH: [ahead, join(home, ".local", "bin"), path, pathWithout("no-mistakes")]
        .filter((dir) => dir !== "")
        .join(":"),
    },
  });
  const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");
  return { status: done.status, out: lines(done.stdout), err: lines(done.stderr) };
}

const withGo = (): string => [piDir, goDir].join(":");
const reminders = async (): Promise<readonly { id: number; to: string; at: string }[]> =>
  (await cardd.board()).schedules;
const setReminder = (updateReminder: boolean | undefined): void => {
  const file = join(scratch.root, "config", "lane.json");
  const lane = parseRecord(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...lane, updateReminder }));
};

test("a fresh install without Go names the missing no-mistakes and the fix, and still sets up the rest", () => {
  const done = install(piDir);
  assert.equal(done.status, 1);
  assert.deepEqual(done.err, [
    `no-mistakes: missing and cannot be built, because go is missing. ${GO_FIX}`,
  ]);
  assert.deepEqual(done.out, [
    `pi-tiers: installed in Pi from ${PI_TIERS}`,
    `tiers: wrote ${agentDir()}/tiers.json from ${template("tiers.json")}`,
    `no-mistakes config: wrote ${nmHome()}/config.yaml from ${template("no-mistakes.yaml")}`,
    `update reminder: created schedule #1, daily at 05:00 ${ZONE}, to main`,
  ]);
  assert.equal(readFileSync(join(nmHome(), "config.yaml"), "utf8").includes("tier/nm-fixer"), true);
});

test("a too old no-mistakes, or the upstream build, fails the install the same way without Go", () => {
  const old = tempDir("old-no-mistakes-");
  writeFileSync(
    join(old, "no-mistakes"),
    "#!/bin/sh\necho 'no-mistakes version fork-0123abcd (0123abcd) 2026-10-01T00:00:00Z'\n",
    { mode: 0o755 },
  );
  assert.deepEqual(install([piDir, old].join(":")).err, [
    `no-mistakes: fork-0123abcd (2026-10-01T00:00:00Z) is too old and cannot be built, because go is missing. ${GO_FIX}`,
  ]);
  writeFileSync(
    join(old, "no-mistakes"),
    "#!/bin/sh\necho 'no-mistakes version v1.106.1 (abcdef12) 2026-11-17T00:00:00Z'\n",
    { mode: 0o755 },
  );
  assert.deepEqual(install([piDir, old].join(":")).err, [
    `no-mistakes: reports "no-mistakes version v1.106.1 (abcdef12) 2026-11-17T00:00:00Z", which is not a build of the 1yian/no-mistakes fork and cannot be built, because go is missing. ${GO_FIX}`,
  ]);
});

test("install builds the fork with Go, installs pi-tiers and the configs, creates one daily reminder to main, and a rerun changes nothing", async () => {
  const commit = commitAt(FIRST);
  const first = install(withGo());
  assert.deepEqual(first.err, []);
  assert.equal(first.status, 0);
  assert.deepEqual(first.out, [
    `no-mistakes: built fork-${commit} into ${target()}`,
    `pi-tiers: installed in Pi from ${PI_TIERS}`,
    `tiers: wrote ${agentDir()}/tiers.json from ${template("tiers.json")}`,
    `no-mistakes config: wrote ${nmHome()}/config.yaml from ${template("no-mistakes.yaml")}`,
    `update reminder: created schedule #1, daily at 05:00 ${ZONE}, to main`,
    `install: ${HOST} is ready`,
  ]);
  assert.equal(execFileSync(target(), ["--version"], { encoding: "utf8" }), version(commit, FIRST));
  const [schedule, ...more] = (await cardd.board()).schedules;
  assert.deepEqual(more, []);
  assert.deepEqual(
    [schedule?.owner, schedule?.to, schedule?.at, schedule?.timezone, schedule?.on],
    ["main", "main", "05:00", ZONE, null],
  );
  for (const part of [
    "Daily fleet update:",
    "update_fleet",
    "pi update --all",
    "fleet install --latest",
    "never no-mistakes update",
    '"updateReminder": false',
  ])
    assert.ok(schedule?.text.includes(part), `the reminder text names ${part}`);

  const again = install(withGo());
  assert.deepEqual(again.err, []);
  assert.deepEqual(again.out, [
    `no-mistakes: fork-${commit} is installed`,
    "pi-tiers: installed in Pi",
    `tiers: ${agentDir()}/tiers.json exists and is kept`,
    `no-mistakes config: ${nmHome()}/config.yaml exists and is kept`,
    `update reminder: already set (schedule #1, daily at 05:00 ${ZONE})`,
    `install: ${HOST} is ready`,
  ]);
  assert.equal((await reminders()).length, 1);
});

test("updateReminder false turns the reminder off and removes it, and turning it back on makes exactly one", async () => {
  commitAt(FIRST);
  assert.equal(install(withGo()).status, 0);
  assert.equal((await reminders()).length, 1);

  setReminder(false);
  assert.deepEqual(install(withGo()).out.slice(-2), [
    "update reminder: off, removed schedule #1",
    `install: ${HOST} is ready`,
  ]);
  assert.deepEqual(await reminders(), []);
  assert.deepEqual(install(withGo()).out.slice(-2), [
    "update reminder: off",
    `install: ${HOST} is ready`,
  ]);

  setReminder(undefined);
  install(withGo());
  install(withGo());
  assert.equal((await reminders()).length, 1);
});

test("install --latest rebuilds the fork only when its main moved", () => {
  const first = commitAt(FIRST);
  install(withGo());
  const same = install(withGo(), ["--latest"]);
  assert.equal(same.out[0], `no-mistakes: fork-${first} is the latest`);

  const second = commitAt(SECOND);
  const moved = install(withGo(), ["--latest"]);
  assert.equal(moved.out[0], `no-mistakes: built fork-${second} into ${target()}`);
  assert.equal(
    execFileSync(target(), ["--version"], { encoding: "utf8" }),
    version(second, SECOND),
  );
  assert.equal(install(withGo(), ["--latest"]).out[0], `no-mistakes: fork-${second} is the latest`);
});

test("install on a host that is not main's skips the reminder, and a cardd that is down fails it", async () => {
  commitAt(FIRST);
  assert.equal(install(withGo()).status, 0);
  await cardd.stop();
  const down = install(withGo());
  assert.equal(down.status, 1);
  assert.equal(down.err.length, 1);
  assert.match(down.err[0] ?? "", /^update reminder: fetch failed \| \S/);

  rmSync(join(scratch.root, "config"), { recursive: true });
  const elsewhere = install(withGo());
  assert.equal(elsewhere.status, 0);
  assert.deepEqual(elsewhere.out.slice(-2), [
    "update reminder: skipped, this host is not main's (no config/lane.json in the checkout)",
    `install: ${HOST} is ready`,
  ]);
});

test("install --latest says so when another no-mistakes on the PATH hides the build it made", () => {
  commitAt(FIRST);
  assert.equal(install(withGo()).status, 0);
  const shadow = tempDir("shadow-");
  const older = "no-mistakes version fork-980a45cf (980a45cf) 2026-11-18T03:52:20Z";
  writeFileSync(join(shadow, "no-mistakes"), `#!/bin/sh\necho '${older}'\n`, { mode: 0o755 });
  const second = commitAt(SECOND);
  const hidden = install(withGo(), ["--latest"], shadow);
  assert.equal(hidden.status, 1);
  assert.deepEqual(hidden.err, [
    `no-mistakes: built fork-${second} into ${target()}, but the no-mistakes on the PATH is "${older}". Fix: put ${join(home, ".local", "bin")} first on the PATH`,
  ]);
});
