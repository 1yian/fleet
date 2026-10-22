import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const WRAPPER = fileURLToPath(new URL("../../bin/no-mistakes-cnp", import.meta.url));
const PERSONAL = "/personal/gh";

const STUB = `#!/bin/sh
printf 'args=%s|NM_HOME=%s|GH_CONFIG_DIR=%s|GIT_SSH_COMMAND=%s|START=%s\\n' "$*" "$NM_HOME" "$GH_CONFIG_DIR" "$GIT_SSH_COMMAND" "$NM_TEST_START_DAEMON" >> "$NM_STUB_LOG"
`;

let dir: string;
let folder: string;
let root: string;
let runs: string;
let log: string;
let env: Record<string, string>;
const daemons: ChildProcess[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-cnp-")));
  folder = join(dir, "cnp");
  root = join(folder, ".no-mistakes");
  runs = join(folder, ".nm-runs");
  log = join(dir, "stub.log");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(folder, ".envrc"),
    `export GH_CONFIG_DIR=${folder}/.config/gh\nexport GIT_SSH_COMMAND='ssh -i ${folder}/key'\n`,
  );
  writeFileSync(join(root, "config.yaml"), "agent: pi\nauto_fix:\n  lint: 3\n");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "no-mistakes"), STUB);
  chmodSync(join(bin, "no-mistakes"), 0o755);
  mkdirSync(join(dir, "direnv"));
  writeFileSync(
    join(dir, "direnv", "direnv.toml"),
    `[whitelist]\nexact = [${JSON.stringify(join(folder, ".envrc"))}]\n`,
  );
  env = {
    PATH: [bin, process.env["PATH"] ?? ""].join(delimiter),
    HOME: dir,
    DIRENV_CONFIG: join(dir, "direnv"),
    XDG_DATA_HOME: join(dir, "data"),
    NM_CNP_FOLDER: folder,
    NM_STUB_LOG: log,
    GH_CONFIG_DIR: PERSONAL,
  };
});

afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.kill();
  rmSync(dir, { recursive: true, force: true });
});

const cnp = (...args: string[]): Promise<{ stdout: string; stderr: string }> =>
  run(WRAPPER, args, { env });

async function refused(args: string[], extra: Record<string, string> = {}): Promise<string> {
  try {
    await run(WRAPPER, args, { env: { ...env, ...extra } });
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(Reflect.get(error, "code"), 2);
    return String(Reflect.get(error, "stderr"));
  }
  throw new Error(`no-mistakes-cnp ${args.join(" ")} was not refused`);
}

const calls = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

function startDaemon(ghConfigDir: string): void {
  const daemon = spawn("sleep", ["300"], {
    env: { ...env, GH_CONFIG_DIR: ghConfigDir },
    stdio: "ignore",
  });
  daemons.push(daemon);
  writeFileSync(join(root, "daemon.pid"), JSON.stringify({ pid: daemon.pid }));
}

const config = (): string => readFileSync(join(root, "config.yaml"), "utf8");

function clone(name: string): string {
  const path = join(dir, "clones", name);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

test("every command runs on the same binary in the CNP root, under the CNP folder's environment, and auto-starts its daemon detached", async () => {
  await cnp("axi", "run", "--intent", "ship it");
  assert.deepEqual(calls(), [
    `args=axi run --intent ship it|NM_HOME=${root}|GH_CONFIG_DIR=${folder}/.config/gh|GIT_SSH_COMMAND=ssh -i ${folder}/key|START=1`,
  ]);
});

test("a shell aimed at another no-mistakes root is refused before anything runs", async () => {
  const why = await refused(["axi", "status"], { NM_HOME: join(dir, "personal") });
  assert.match(why, /NM_HOME is set to another root/);
  assert.deepEqual(calls(), []);
});

test("a folder whose direnv environment does not load is refused instead of running with personal credentials", async () => {
  writeFileSync(join(folder, ".envrc"), "export SOMETHING_ELSE=1\n");
  const why = await refused(["axi", "status"]);
  assert.match(why, /the CNP environment of .* did not load/);
  assert.deepEqual(calls(), []);
});

test("a daemon that was started outside the CNP environment is refused, and can still be stopped", async () => {
  startDaemon(PERSONAL);
  const why = await refused(["axi", "run", "--intent", "ship it"]);
  assert.match(why, /does not run in the CNP environment/);
  assert.deepEqual(calls(), []);
  await cnp("daemon", "stop");
  assert.equal(calls().length, 1);
  assert.match(calls()[0] ?? "", /^args=daemon stop\|/);
});

test("a daemon that runs in the CNP environment is used", async () => {
  startDaemon(`${folder}/.config/gh`);
  await cnp("axi", "status");
  assert.equal(calls().length, 1);
});

test("registration places a clone's runs under the CNP run folder, keeps every other line of the config, and drops the entry when its last owner is released", async () => {
  const web = clone("web");
  const aegis = clone("aegis");
  await cnp("register", web, "c-1");
  await cnp("register", web, "c-2");
  await cnp("register", aegis, "c-3");
  const text = config();
  assert.match(text, /^agent: pi\nauto_fix:\n {2}lint: 3\n/);
  const entries = text.match(/^ {2}(\/.*): (\/.*)$/gm) ?? [];
  assert.equal(entries.length, 2);
  for (const path of [web, aegis]) {
    const entry = entries.find((each) => each.startsWith(`  ${path}: `));
    assert.ok(entry !== undefined, `${path} is registered`);
    const place = entry.slice(`  ${path}: `.length);
    assert.ok(place.startsWith(`${runs}/`), `${place} is under the CNP run folder`);
    assert.ok(existsSync(place));
  }

  await cnp("release", web, "c-1");
  assert.match(config(), new RegExp(`^ {2}${web}: `, "m"));
  await cnp("release", web, "c-2");
  assert.doesNotMatch(config(), new RegExp(web));
  assert.match(config(), new RegExp(`^ {2}${aegis}: `, "m"));
  await cnp("release", aegis, "c-3");
  assert.equal(config(), "agent: pi\nauto_fix:\n  lint: 3\n");
});

test("registering and releasing again, or releasing an owner that never registered, converges", async () => {
  const web = clone("web");
  await cnp("register", web, "c-1");
  const once = config();
  await cnp("register", web, "c-1");
  assert.equal(config(), once);
  await cnp("release", web, "c-9");
  assert.equal(config(), once);
  await cnp("release", web, "c-1");
  await cnp("release", web, "c-1");
  assert.equal(config(), "agent: pi\nauto_fix:\n  lint: 3\n");
});

test("concurrent registrations of different clones all land, and a lock left by a dead process does not block", async () => {
  mkdirSync(join(runs, ".owners"), { recursive: true });
  mkdirSync(join(runs, ".lock"));
  writeFileSync(join(runs, ".lock", "pid"), "2147483646");
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  await Promise.all(names.map((name) => cnp("register", clone(name), `c-${name}`)));
  const entries = config().match(/^ {2}\/.*$/gm) ?? [];
  assert.equal(entries.length, names.length);
  assert.ok(!existsSync(join(runs, ".lock")));
});

test("registration refuses a clone inside the CNP root, and a missing root config, without leaving an entry", async () => {
  const inside = join(root, "repos", "x");
  mkdirSync(inside, { recursive: true });
  assert.match(await refused(["register", inside, "c-1"]), /inside the CNP root or run folder/);
  assert.equal(config(), "agent: pi\nauto_fix:\n  lint: 3\n");
  rmSync(join(root, "config.yaml"));
  assert.match(await refused(["register", clone("web"), "c-1"]), /create the CNP root first/);
  assert.deepEqual(readdirSync(join(runs, ".owners")), []);
});
