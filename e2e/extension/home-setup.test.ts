import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HerdrLab } from "../support/herdr.ts";
import { parseRecord } from "../support/json.ts";
import { git } from "../support/remote.ts";
import { Scratch } from "../support/scratch.ts";

const LANE_URL = "ws://127.0.0.1:7420/session";
const TOKEN = "-tok-3f9c2a71e8d44b0a";

let scratch: Scratch;
let lab: HerdrLab;
beforeEach(async () => {
  scratch = new Scratch();
  lab = await HerdrLab.start({});
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  await lab.stop();
  scratch.dispose();
});

const homeOf = (lane: string): string => join(`${scratch.root}.worktrees`, `lane-${lane}`);
const laneFile = (lane: string): Record<string, unknown> =>
  parseRecord(readFileSync(join(homeOf(lane), "config", "lane.json"), "utf8"));

function run(args: readonly string[], input?: string) {
  const done = spawnSync("node", [scratch.launch, ...args], {
    encoding: "utf8",
    env: { ...process.env, HERDR_SESSION: lab.name },
    ...(input === undefined ? {} : { input }),
  });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

function ok(args: readonly string[], input?: string): { stdout: string; stderr: string } {
  const done = run(args, input);
  assert.equal(done.status, 0, done.stderr);
  return done;
}

function refused(args: readonly string[], input?: string): string {
  const done = run(args, input);
  assert.notEqual(done.status, 0, done.stdout);
  return done.stderr;
}

test("home add reads the token from standard input or a file and never prints it", () => {
  const piped = ok(["home", "add", "cleo", "--url", LANE_URL, "--token-file", "-"], `${TOKEN}\n`);
  assert.equal(piped.stdout.trim(), homeOf("cleo"));
  assert.equal(laneFile("cleo")["token"], TOKEN);

  const file = join(scratch.parent, "leo.token");
  writeFileSync(file, `${TOKEN}-leo\n`, { mode: 0o600 });
  const filed = ok(["home", "add", "leo", "--url", LANE_URL, "--token-file", file]);
  assert.equal(laneFile("leo")["token"], `${TOKEN}-leo`);

  for (const text of [piped.stdout, piped.stderr, filed.stdout, filed.stderr])
    assert.ok(!text.includes(TOKEN), "the token reached the output");

  assert.match(
    refused(["home", "add", "zed", "--url", LANE_URL, "--token-file", "-"], "\n"),
    /standard input holds no token/,
  );
  assert.match(
    refused(["home", "add", "zed", "--url", LANE_URL, "--token", "x", "--token-file", "-"], "y\n"),
    /give --token or --token-file, not both/,
  );
  assert.equal(existsSync(homeOf("zed")), false);
});

test("home add with --token still works, and says that the token is now in the process list", () => {
  const done = ok(["home", "add", "cleo", "--url", LANE_URL, "--token", TOKEN]);
  assert.equal(laneFile("cleo")["token"], TOKEN);
  assert.match(done.stderr, /--token puts the token in the process list.*--token-file -/);
  assert.ok(!done.stderr.includes(TOKEN));
});

test("home add finishes a worktree that was made ahead, and a rerun changes nothing", () => {
  git(scratch.root, "worktree", "add", "--detach", homeOf("cleo"), "HEAD");
  assert.equal(run(["status", "--json"]).stdout.trim(), "[]");

  const made = ok(["home", "add", "cleo", "--url", LANE_URL, "--token-file", "-"], `${TOKEN}\n`);
  assert.equal(made.stdout.trim(), homeOf("cleo"));
  const before = readFileSync(join(homeOf("cleo"), "config", "lane.json"), "utf8");
  assert.equal(laneFile("cleo")["token"], TOKEN);
  assert.ok(existsSync(join(homeOf("cleo"), "node_modules")));
  assert.ok(existsSync(join(homeOf("cleo"), "data")) && existsSync(join(homeOf("cleo"), "state")));

  const again = ok(["home", "add", "cleo"]);
  assert.equal(again.stdout.trim(), homeOf("cleo"));
  assert.match(again.stderr, /the home is made already, and config\/lane\.json is kept/);
  assert.equal(readFileSync(join(homeOf("cleo"), "config", "lane.json"), "utf8"), before);

  mkdirSync(homeOf("leo"), { recursive: true });
  assert.match(
    refused(["home", "add", "leo", "--url", LANE_URL, "--token-file", "-"], `${TOKEN}\n`),
    /lane-leo exists and is not a worktree of/,
  );
  assert.equal(existsSync(join(homeOf("leo"), "config")), false);
});

test("a home added with --hold is held, so no pass starts its mate until it is started", () => {
  ok(["home", "add", "cleo", "--url", LANE_URL, "--token-file", "-", "--hold"], `${TOKEN}\n`);
  assert.deepEqual(JSON.parse(run(["status", "--json"]).stdout), [
    { lane: "cleo", state: "stopped", reason: "held since the home was made" },
  ]);
  assert.equal(
    run(["up"]).stdout,
    "cleo: stopped: held since the home was made\n",
    "a pass that names no lane started the held home",
  );
});

test("home set changes a lane's settings in place, keeps its token and the rest, and checks them first", () => {
  ok(
    [
      "home",
      "add",
      "cleo",
      "--url",
      LANE_URL,
      "--token-file",
      "-",
      "--tier",
      "tier/weaker-orchestrator",
      "--args",
      '["--model","tier/quick"]',
      "--hosts",
      '{"p620":["ssh","p620"]}',
    ],
    `${TOKEN}\n`,
  );
  const args = ["--no-skills", "--skill", "/scratch/skills", "--skill", "/home/.agents/skills"];

  const set = ok([
    "home",
    "set",
    "cleo",
    "--args",
    JSON.stringify(args),
    "--tier",
    "",
    "--worker-args",
    '["--model","tier/quick"]',
  ]);
  assert.equal(
    set.stdout.trim(),
    "cleo: set tier, args, workerArgs. Restart the lane for its mate to use them",
  );
  const file = laneFile("cleo");
  assert.deepEqual(file["args"], args);
  assert.deepEqual(file["workerArgs"], ["--model", "tier/quick"]);
  assert.equal("tier" in file, false);
  assert.equal(file["token"], TOKEN);
  assert.deepEqual(file["hosts"], { p620: ["ssh", "p620"] });
  assert.equal(file["url"], LANE_URL);

  const before = readFileSync(join(homeOf("cleo"), "config", "lane.json"), "utf8");
  assert.match(
    refused(["home", "set", "cleo", "--args", '{"a":1}']),
    /--args must be a JSON array of strings/,
  );
  assert.match(refused(["home", "set", "cleo", "--roots", '{"p620":3}']), /--roots must be/);
  assert.match(refused(["home", "set", "cleo", "--direnv", "cnp"]), /"direnv" must be an absolute/);
  assert.match(refused(["home", "set", "ghost", "--args", "[]"]), /no lane ghost on this host/);
  assert.match(refused(["home", "set", "cleo"]), /usage: fleet/);
  assert.equal(readFileSync(join(homeOf("cleo"), "config", "lane.json"), "utf8"), before);
});

test("fleet --help lists the options of home add and home set", () => {
  const help = execFileSync("node", [scratch.launch, "--help"], { encoding: "utf8" });
  for (const option of [
    "--token-file",
    "--token",
    "--bws",
    "--hold",
    "--host",
    "--hosts",
    "--roots",
    "--tier",
    "--args",
    "--worker-args",
    "--direnv",
    "home set",
  ])
    assert.ok(help.includes(option), `fleet --help does not list ${option}`);
});
