import assert from "node:assert/strict";
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
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { commitFork, initFork, routeFork } from "../support/fork-fixture.ts";
import { parseRecord } from "../support/json.ts";
import { addRemote } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";
import { Scratch } from "../support/scratch.ts";
import { seedTiers } from "../support/tiers-fixture.ts";

const PI_TIERS = "git:github.com/1yian/pi-tiers";

let here: Scratch;
let home: string;
let tools: string;
let log: string;
let state: string;
let fork: string;

function wrapper(name: string, script: string): void {
  const target = fileURLToPath(new URL(`../support/${script}`, import.meta.url));
  writeFileSync(join(tools, name), `#!/bin/sh\nexec node "${target}" "$@"\n`);
  chmodSync(join(tools, name), 0o755);
}

beforeEach(() => {
  here = new Scratch();
  addRemote(here.root);
  home = tempDir("home-");
  tools = tempDir("tools-");
  wrapper("pi", "fake-pi.ts");
  wrapper("go", "fake-go.ts");
  log = join(home, "pi.log");
  state = join(home, "pi-packages");
  writeFileSync(log, "");
  writeFileSync(state, `${PI_TIERS}\n`);
  fork = join(tempDir("fork-"), "no-mistakes");
  mkdirSync(fork);
  initFork(fork);
});
afterEach(() => {
  here.dispose();
});

const piCalls = (): string[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");

const target = (): string => join(home, ".local", "bin", "no-mistakes");

function dependenciesOf(report: Record<string, unknown>): string[] {
  const found = report["dependencies"];
  assert.ok(Array.isArray(found));
  return found.map(String);
}

function update(env: Record<string, string> = {}): Record<string, unknown> {
  return parseRecord(
    here.fleet(["update"], {
      HOME: home,
      FAKE_PI_STATE: state,
      FAKE_PI_LOG: log,
      PATH: [tools, join(home, ".local", "bin"), process.env["PATH"] ?? ""].join(delimiter),
      ...env,
    }),
  );
}

test("fleet update brings Pi, only pi-tiers, and the no-mistakes fork to their latest remote", () => {
  const commit = commitFork(fork, "2026-11-20T09:00:00-06:00");
  const cli = join(home, ".local", "bin", "fleet-browser");
  const skill = join(process.env["PI_CODING_AGENT_DIR"] ?? "", "skills", "fleet-browser");
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(dirname(skill), { recursive: true });
  const oldCheckout = tempDir("old-browser-");
  symlinkSync(join(oldCheckout, "bin", "fleet-browser.js"), cli);
  symlinkSync(join(oldCheckout, "skills", "fleet-browser"), skill);
  const report = update(routeFork(fork));
  assert.equal(report["state"], "updated");
  assert.deepEqual(report["dependencies"], [
    "Pi: pi is up to date",
    `pi-tiers: Updated ${PI_TIERS}`,
    `no-mistakes: built fork-${commit} into ${target()}`,
    "fleet-browser: CLI and skill linked",
  ]);
  const browser = join(realpathSync(here.root), "packages", "fleet-browser");
  assert.equal(realpathSync(cli), join(browser, "bin", "fleet-browser.js"));
  assert.equal(realpathSync(skill), join(browser, "skills", "fleet-browser"));
  assert.ok(existsSync(join(browser, "dist", "daemon", "main.js")));
  assert.deepEqual(piCalls(), ["update", "list", `update ${PI_TIERS}`]);
  assert.equal(
    readFileSync(target(), "utf8"),
    `#!/bin/sh\necho "no-mistakes version fork-${commit} (${commit}) 2026-11-20T15:00:00Z"\n`,
  );
  assert.equal(update(routeFork(fork))["state"], "updated");
  assert.deepEqual(
    dependenciesOf(update(routeFork(fork)))[2],
    `no-mistakes: fork-${commit} is the latest`,
  );
});

test("fleet update leaves a real skill directory intact and reports the conflict", () => {
  const cli = join(home, ".local", "bin", "fleet-browser");
  const agentDir = tempDir("agent-");
  seedTiers(agentDir);
  const skill = join(agentDir, "skills", "fleet-browser");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "local skill\n");
  mkdirSync(dirname(cli), { recursive: true });
  const old = join(tempDir("old-browser-"), "bin", "fleet-browser.js");
  symlinkSync(old, cli);
  const report = update({ PI_CODING_AGENT_DIR: agentDir });
  assert.equal(report["state"], "updated");
  assert.match(
    dependenciesOf(report).at(-1) ?? "",
    /^fleet-browser: not updated: .*fleet-browser is not a link, so it was left intact/,
  );
  assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), "local skill\n");
  assert.equal(lstatSync(skill).isDirectory(), true);
  assert.equal(readlinkSync(cli), old);
});

test("fleet update reports a pinned pi-tiers and a Pi that another manager owns as not updated, and still updates", () => {
  const pinned = `${PI_TIERS}@v0.1.14`;
  writeFileSync(state, `${pinned}\n`);
  const refusal = "Pi was installed by Nix: update it with nix profile upgrade pi";
  const agentDir = tempDir("agent-");
  seedTiers(agentDir);
  const report = update({ FAKE_PI_SELF_UPDATE_REFUSAL: refusal, PI_CODING_AGENT_DIR: agentDir });
  assert.equal(report["state"], "updated");
  const dependencies = dependenciesOf(report);
  assert.deepEqual(dependencies.slice(0, 2), [
    `Pi: not updated: ${refusal}`,
    `pi-tiers: pinned at ${pinned}, so it was not updated: Pi never moves a pinned ref. Reinstall it with pi install ${PI_TIERS} to follow the default branch`,
  ]);
  assert.match(dependencies[2] ?? "", /^no-mistakes: fork-[0-9a-f]{8} is the latest$/);
  assert.equal(dependencies.length, 3);
  assert.equal(
    lstatSync(join(home, ".local", "bin", "fleet-browser"), { throwIfNoEntry: false }),
    undefined,
  );
  assert.equal(
    lstatSync(join(agentDir, "skills", "fleet-browser"), { throwIfNoEntry: false }),
    undefined,
  );
  assert.deepEqual(piCalls(), ["update", "list"]);
});

test("fleet update never installs a fork build below the minimum, and says so", () => {
  const commit = commitFork(fork, "2026-11-01T00:00:00-06:00");
  const report = update(routeFork(fork));
  assert.equal(report["state"], "updated");
  assert.equal(
    dependenciesOf(report)[2],
    `no-mistakes: not updated: the latest build of 1yian/no-mistakes, fork-${commit} (2026-11-01T06:00:00Z) is too old, was staged and not installed: the existing no-mistakes is unchanged`,
  );
  assert.equal(existsSync(target()), false);
});
