import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { commitFork, initFork, routeFork } from "../support/fork-fixture.ts";
import { parseRecord } from "../support/json.ts";
import { addRemote } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";
import { Scratch } from "../support/scratch.ts";

const PI_TIERS = "git:github.com/1yian/pi-tiers";
const BUN = '#!/bin/sh\ncase "$1" in --version) echo 1.3.13 ;; esac\n';

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
  writeFileSync(join(tools, "bun"), BUN);
  chmodSync(join(tools, "bun"), 0o755);
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
  const report = update(routeFork(fork));
  assert.equal(report["state"], "updated");
  assert.deepEqual(report["dependencies"], [
    "Pi: pi is up to date",
    `pi-tiers: Updated ${PI_TIERS}`,
    `no-mistakes: built fork-${commit} into ${target()}`,
  ]);
  assert.deepEqual(piCalls(), ["update", "list", `update ${PI_TIERS}`]);
  assert.equal(
    readFileSync(target(), "utf8"),
    `#!/bin/sh\necho "no-mistakes version fork-${commit} (${commit}) 2026-11-20T15:00:00Z"\n`,
  );
  assert.equal(update(routeFork(fork))["state"], "updated");
  assert.deepEqual(
    (update(routeFork(fork))["dependencies"] as string[]).at(-1),
    `no-mistakes: fork-${commit} is the latest`,
  );
});

test("fleet update reports a pinned pi-tiers and a Pi that another manager owns as not updated, and still updates", () => {
  const pinned = `${PI_TIERS}@v0.1.14`;
  writeFileSync(state, `${pinned}\n`);
  const refusal = "Pi was installed by Nix: update it with nix profile upgrade pi";
  const report = update({ FAKE_PI_SELF_UPDATE_REFUSAL: refusal });
  assert.equal(report["state"], "updated");
  const dependencies = report["dependencies"] as string[];
  assert.deepEqual(dependencies.slice(0, 2), [
    `Pi: not updated: ${refusal}`,
    `pi-tiers: pinned at ${pinned}, so it was not updated: Pi never moves a pinned ref. Reinstall it with pi install ${PI_TIERS} to follow the default branch`,
  ]);
  assert.match(dependencies[2] ?? "", /^no-mistakes: fork-[0-9a-f]{8} is the latest$/);
  assert.deepEqual(piCalls(), ["update", "list"]);
});

test("fleet update never installs a fork build below the minimum, and says so", () => {
  const commit = commitFork(fork, "2026-11-01T00:00:00-06:00");
  const report = update(routeFork(fork));
  assert.equal(report["state"], "updated");
  assert.equal(
    (report["dependencies"] as string[]).at(-1),
    `no-mistakes: not updated: the latest build of 1yian/no-mistakes, fork-${commit} (2026-11-01T06:00:00Z) is too old, was staged and not installed: the existing no-mistakes is unchanged`,
  );
  assert.equal(existsSync(target()), false);
});
