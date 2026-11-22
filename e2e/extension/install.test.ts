import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { parseRecord } from "../support/json.ts";
import { commitFork, initFork, routeFork } from "../support/fork-fixture.ts";
import { tempDir } from "../support/run-root.ts";
import { configureMain, Scratch } from "../support/scratch.ts";
import { pathWithout } from "../support/tool-stubs.ts";

const HOST = hostname();
const ZONE = "America/Chicago";
const FIRST = "2026-11-19T08:47:26-06:00";
const GO_FIX =
  "Fix: install Go 1.25 or later (brew install go, or apt install golang-go), then run fleet install again";
const PI_TIERS = "git:github.com/1yian/pi-tiers";

let cardd: Cardd;
let mainToken: string;
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

const commitAt = (when: string): string => commitFork(repo, when);

beforeEach(async () => {
  cardd = await Cardd.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main");
  configureMain(scratch, cardd.url, mainToken);
  home = tempDir("home-");
  piDir = wrapper(tempDir("fake-pi-"), "pi", "fake-pi.ts");
  goDir = wrapper(tempDir("fake-go-"), "go", "fake-go.ts");
  repo = join(tempDir("fork-"), "no-mistakes");
  mkdirSync(repo, { recursive: true });
  initFork(repo);
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

function install(path: string, ahead = "", extra: Record<string, string> = {}): Run {
  const done = spawnSync("node", [scratch.launch, "install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TZ: ZONE,
      PI_CODING_AGENT_DIR: agentDir(),
      NM_HOME: nmHome(),
      FAKE_PI_STATE: join(home, "pi-packages"),
      ...routeFork(repo),
      ...extra,
      PATH: [ahead, join(home, ".local", "bin"), path, pathWithout("no-mistakes")]
        .filter((dir) => dir !== "")
        .join(":"),
    },
  });
  const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");
  return { status: done.status, out: lines(done.stdout), err: lines(done.stderr) };
}

interface Tree {
  [key: string]: Tree | string;
}

function yamlTree(text: string): Tree {
  const root: Tree = {};
  const path: Tree[] = [root];
  for (const line of text.split("\n")) {
    const entry = line.trim();
    if (entry === "") continue;
    const depth = (line.length - line.trimStart().length) / 2;
    const parent = path[depth] ?? root;
    path.length = depth + 1;
    if (entry.endsWith(":")) {
      const child: Tree = {};
      parent[entry.slice(0, -1)] = child;
      path.push(child);
    } else {
      const split = entry.indexOf(": ");
      parent[entry.slice(0, split)] = entry.slice(split + 2);
    }
  }
  return root;
}

function valueAt(tree: Tree, ...keys: string[]): string | undefined {
  let node: Tree | string | undefined = tree;
  for (const key of keys) node = typeof node === "object" ? node[key] : undefined;
  return typeof node === "string" ? node : undefined;
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
    "fleet-browser: CLI and skill linked",
    `tiers: wrote ${agentDir()}/tiers.json from ${template("tiers.json")}`,
    `no-mistakes config: wrote ${nmHome()}/config.yaml from ${template("no-mistakes.yaml")}`,
    `update reminder: created schedule #1, daily at 05:00 ${ZONE}, to main`,
  ]);
  const config = yamlTree(readFileSync(join(nmHome(), "config.yaml"), "utf8"));
  assert.equal(valueAt(config, "agent"), "pi");
  assert.equal(valueAt(config, "agent_config", "pi", "model"), "tier/nm-default");
  assert.equal(valueAt(config, "review_agents", "reviewer", "model"), "tier/reviewer");
  assert.equal(valueAt(config, "review_agents", "fixer", "model"), "tier/nm-fixer");
});

test("an empty PI_TIERS_CONFIG writes the tiers file at the default Pi location", () => {
  const done = install(piDir, "", { PI_TIERS_CONFIG: "" });
  assert.ok(
    done.out.includes(`tiers: wrote ${agentDir()}/tiers.json from ${template("tiers.json")}`),
  );
});

test("a Pi package that only contains pi-tiers in its name does not stand in for pi-tiers, and a pinned pi-tiers does", () => {
  const state = join(home, "pi-packages");
  writeFileSync(
    state,
    "git:github.com/example/pi-tiers-extras\ngit:github.com/1yian/pi-tiers-fork\n",
  );
  assert.ok(install(piDir).out.includes(`pi-tiers: installed in Pi from ${PI_TIERS}`));
  rmSync(state);
  writeFileSync(state, `${PI_TIERS}@v0.1.14\n`);
  assert.ok(install(piDir).out.includes("pi-tiers: installed in Pi"));
  assert.equal(readFileSync(state, "utf8"), `${PI_TIERS}@v0.1.14\n`);
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
    "fleet-browser: CLI and skill linked",
    `tiers: wrote ${agentDir()}/tiers.json from ${template("tiers.json")}`,
    `no-mistakes config: wrote ${nmHome()}/config.yaml from ${template("no-mistakes.yaml")}`,
    `update reminder: created schedule #1, daily at 05:00 ${ZONE}, to main`,
    `install: ${HOST} is ready`,
  ]);
  assert.equal(execFileSync(target(), ["--version"], { encoding: "utf8" }), version(commit, FIRST));
  const browser = join(home, ".local", "bin", "fleet-browser");
  assert.match(execFileSync(browser, ["--help"], { encoding: "utf8" }), /login --stdin/);
  assert.equal(
    realpathSync(join(agentDir(), "skills", "fleet-browser", "SKILL.md")),
    join(
      realpathSync(scratch.root),
      "packages",
      "fleet-browser",
      "skills",
      "fleet-browser",
      "SKILL.md",
    ),
  );
  const [schedule, ...more] = (await cardd.board()).schedules;
  assert.deepEqual(more, []);
  assert.deepEqual(
    [schedule?.owner, schedule?.to, schedule?.at, schedule?.timezone, schedule?.on],
    ["main", "main", "05:00", ZONE, null],
  );
  for (const part of [
    "Daily fleet update:",
    "update_fleet",
    "Pi, pi-tiers, and the no-mistakes fork",
    '"updateReminder": false',
  ])
    assert.ok(schedule?.text.includes(part), `the reminder text names ${part}`);

  const again = install(withGo());
  assert.deepEqual(again.err, []);
  assert.deepEqual(again.out, [
    `no-mistakes: fork-${commit} is installed`,
    "pi-tiers: installed in Pi",
    "fleet-browser: CLI and skill linked",
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

test("a one-off schedule with the reminder's text is not the daily reminder, and turning the reminder off leaves it", async () => {
  commitAt(FIRST);
  assert.equal(install(withGo()).status, 0);
  const [daily] = (await cardd.board()).schedules;
  assert.ok(daily !== undefined);
  const main = await cardd.connect(mainToken);
  try {
    await main.call("schedule.set", {
      id: daily.id,
      to: "main",
      at: daily.at,
      timezone: daily.timezone,
      on: "2099-01-01",
      text: daily.text,
    });
    const again = install(withGo());
    assert.match(again.out.at(-2) ?? "", /^update reminder: created schedule #\d+, daily at 05:00/);
    const both = (await cardd.board()).schedules;
    assert.equal(both.length, 2);
    assert.equal(both.filter(({ on }) => on === null).length, 1);
    assert.equal(both.filter(({ on }) => on === "2099-01-01").length, 1);

    setReminder(false);
    assert.equal(install(withGo()).status, 0);
    assert.deepEqual(
      (await cardd.board()).schedules.map(({ id, on }) => [id, on]),
      [[daily.id, "2099-01-01"]],
    );
  } finally {
    await main.close();
  }
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

test("install says so when an older no-mistakes on the PATH hides the build it made", () => {
  const shadow = tempDir("shadow-");
  const older = "no-mistakes version fork-0123abcd (0123abcd) 2026-10-01T00:00:00Z";
  writeFileSync(join(shadow, "no-mistakes"), `#!/bin/sh\necho '${older}'\n`, { mode: 0o755 });
  const commit = commitAt(FIRST);
  const hidden = install(withGo(), shadow);
  assert.equal(hidden.status, 1);
  assert.deepEqual(hidden.err, [
    `no-mistakes: built fork-${commit} into ${target()}, but the no-mistakes on the PATH is "${older}". Fix: put ${join(home, ".local", "bin")} first on the PATH`,
  ]);
});

test("install refuses to publish a fork build below the minimum, and leaves nothing installed", () => {
  const commit = commitAt("2026-11-01T00:00:00-06:00");
  const done = install(withGo());
  assert.equal(done.status, 1);
  assert.deepEqual(done.err, [
    `no-mistakes: the latest build of 1yian/no-mistakes, fork-${commit} (2026-11-01T06:00:00Z) is too old, was staged and not installed: the existing no-mistakes is unchanged`,
  ]);
  assert.equal(existsSync(target()), false);
  assert.equal(existsSync(`${target()}.new`), false);
});
