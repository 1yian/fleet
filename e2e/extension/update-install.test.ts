import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseRecord } from "../support/json.ts";
import { addRemote, landOnRemote, tip } from "../support/remote.ts";
import { Scratch } from "../support/scratch.ts";
import { pathWithout } from "../support/tool-stubs.ts";

const STUB = `#!/bin/sh
echo "$*" >> "$BUN_LOG"
case "$1" in
  --version) echo 1.3.13 ;;
  install)
    if [ -n "$BUN_INSTALL_FAILS" ]; then
      echo "error: lockfile had changes, but lockfile is frozen" >&2
      exit 1
    fi
    ;;
esac
`;

let here: Scratch;
let remote: string;
let log: string;
let path: string;

beforeEach(() => {
  here = new Scratch();
  remote = addRemote(here.root);
  const bin = join(here.parent, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), STUB);
  chmodSync(join(bin, "bun"), 0o755);
  log = join(here.parent, "bun.log");
  writeFileSync(log, "");
  path = [bin, process.env["PATH"] ?? ""].join(delimiter);
});
afterEach(() => {
  here.dispose();
});

const bunCalls = (): string[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "" && line !== "--version");

const update = (env: Record<string, string> = {}): Record<string, unknown> =>
  parseRecord(here.fleet(["update"], { PATH: path, BUN_LOG: log, ...env }));

test("fleet update installs with a frozen bun.lock when the lockfile changed, then builds the board", () => {
  const landed = landOnRemote(remote, "lock", "bun.lock", "changed\n");
  const report = update();
  assert.equal(report["state"], "updated");
  assert.equal(report["installed"], true);
  assert.equal(report["to"], landed);
  assert.deepEqual(bunCalls(), ["install --frozen-lockfile", "run build"]);
});

test("fleet update only builds the board when the lockfile did not change and the packages are there", () => {
  assert.ok(existsSync(join(here.root, "node_modules")));
  landOnRemote(remote, "code", "packages/protocol/src/extra.ts", "export {};\n");
  const report = update();
  assert.equal(report["state"], "updated");
  assert.equal(report["installed"], false);
  assert.deepEqual(bunCalls(), ["run build"]);
});

test("fleet update reports a failed bun install by step and cause, and builds nothing", () => {
  const before = tip(here.root);
  const landed = landOnRemote(remote, "lock", "bun.lock", "changed\n");
  const report = update({ BUN_INSTALL_FAILS: "1" });
  assert.equal(report["state"], "failed");
  assert.equal(report["step"], "bun install");
  assert.equal(report["from"], before);
  assert.equal(report["to"], landed);
  assert.match(String(report["error"]), /lockfile had changes, but lockfile is frozen/);
  assert.deepEqual(bunCalls(), ["install --frozen-lockfile"]);
});

test("fleet update and its check refuse a host without bun, name the fix, and leave the checkout where it was", () => {
  const before = tip(here.root);
  landOnRemote(remote, "lock", "bun.lock", "changed\n");
  const noBun = pathWithout("bun");
  const problem = `bun is missing on ${hostname()}. Fix: install bun 1.3.13 or later: brew install oven-sh/bun/bun (macOS), or see https://bun.sh/docs/installation`;
  for (const args of [["update", "--check"], ["update"]]) {
    const report = parseRecord(here.fleet(args, { PATH: noBun, BUN_LOG: log }));
    assert.equal(report["state"], "refused");
    assert.ok(Array.isArray(report["problems"]));
    assert.ok(report["problems"].includes(problem));
  }
  assert.equal(tip(here.root), before);
  assert.deepEqual(bunCalls(), []);
});
