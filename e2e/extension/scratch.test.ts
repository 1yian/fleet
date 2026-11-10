import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  symlinkSync,
  utimesSync,
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
import { isRecord, parseRecord, records } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const LAUNCH = fileURLToPath(new URL("../../packages/extension/src/launch.ts", import.meta.url));
const DAY_MS = 86_400_000;

const fleet = (args: readonly string[], env: Record<string, string>): string =>
  execFileSync(process.execPath, [LAUNCH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

function listing(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...listing(join(root, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

function backdate(path: string, days: number): void {
  const then = new Date(Date.now() - days * DAY_MS);
  utimesSync(path, then, then);
}

const WORKER_SCRIPT = `
printf '%s\\n%s\\n%s\\n' "$FLEET_SCRATCH" "$TMPDIR" "$NODE_COMPILE_CACHE" > "$FLEET_SCRATCH/env.txt"
if [ -r /proc/$PPID/environ ]; then
  tr '\\0' '\\n' < /proc/$PPID/environ | grep -E '^(NODE_COMPILE_CACHE|TMPDIR|FLEET_SCRATCH)=' | sort > "$FLEET_SCRATCH/pi-environ.txt"
fi
echo "findings for the mate" > "$FLEET_SCRATCH/report.md"
echo "a clone that the worker made" > "$TMPDIR/clone.txt"
echo 'module.exports = 1;' > "$FLEET_SCRATCH/probe.cjs"
node "$FLEET_SCRATCH/probe.cjs"
`;

let parts: DispatchLab;
let home: string;
beforeEach(async () => {
  home = tempDir("fleet-host-home-");
  const config = process.env["XDG_CONFIG_HOME"] ?? join(process.env["HOME"] ?? "", ".config");
  parts = await startDispatchLab({
    workerArgs: ["-e", SHELL],
    mate: { HOME: home, XDG_CONFIG_HOME: config, FLEET_HOST_DIR: "" },
  });
  parts.cardd.yolo("site");
});
afterEach(async () => {
  await stopDispatchLab(parts);
});

test("a worker starts with its scratch, temp, and compile cache on disk under the host's fleet folder, and close removes its temp folder at once and keeps its evidence", async () => {
  const { h, mate } = parts;
  const hostDir = join(home, ".fleet");
  const card = join(hostDir, "scratch", "c-1");
  let whileOpen: string[] = [];
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Run the tests",
        name: "run-the-tests",
        kind: "ship",
        project: "site",
        intent: "Run the tests",
        host: "local",
        task: "run them",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command: WORKER_SCRIPT } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => {
    whileOpen = listing(card).filter((name) => !name.startsWith("tmp/jiti"));
    return { tool: "close", args: { card: 1, summary: "Done." } };
  }, "mate");
  await connected(h);
  mate.prompt("run the tests");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));

  assert.deepEqual(whileOpen, [
    "env.txt",
    ...(process.platform === "linux" ? ["pi-environ.txt"] : []),
    "probe.cjs",
    "report.md",
    "tmp/",
    "tmp/clone.txt",
  ]);
  const env = readFileSync(join(card, "env.txt"), "utf8").trim().split("\n");
  assert.deepEqual(env, [card, join(card, "tmp"), join(hostDir, "node-compile-cache")]);
  assert.notEqual(env[1], process.env["TMPDIR"]);
  if (process.platform === "linux") {
    assert.deepEqual(readFileSync(join(card, "pi-environ.txt"), "utf8").trim().split("\n"), [
      `FLEET_SCRATCH=${card}`,
      `NODE_COMPILE_CACHE=${join(hostDir, "node-compile-cache")}`,
      `TMPDIR=${join(card, "tmp")}`,
    ]);
  }
  const cached = listing(join(hostDir, "node-compile-cache"));
  assert.ok(
    cached.some((name) => !name.endsWith("/")),
    `the worker's node processes wrote compile cache entries under the host folder: ${cached.join(", ")}`,
  );

  assert.equal(results.at(-1), "c-1 is done.");
  assert.deepEqual(listing(card), [
    "closed",
    "env.txt",
    ...(process.platform === "linux" ? ["pi-environ.txt"] : []),
    "probe.cjs",
    "report.md",
  ]);
});

test("dispatching a card again reopens its folder: the closed mark goes and the evidence stays", async () => {
  const hostDir = join(home, ".fleet");
  const card = join(hostDir, "scratch", "c-1");
  mkdirSync(join(card, "tmp"), { recursive: true });
  writeFileSync(join(card, "closed"), "");
  writeFileSync(join(card, "report.md"), "earlier evidence");
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Run the tests",
        name: "run-the-tests",
        kind: "ship",
        project: "site",
        intent: "Run the tests",
        host: "local",
        task: "run them",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  await connected(h);
  mate.prompt("run the tests");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  assert.deepEqual(listing(card), ["report.md", "tmp/"]);
});

function seedCard(root: string, name: string, ageDays: number, closed: boolean): string {
  const card = join(root, "scratch", name);
  mkdirSync(join(card, "tmp", "deps"), { recursive: true });
  writeFileSync(join(card, "tmp", "deps", "index.js"), "x");
  writeFileSync(join(card, "report.md"), "evidence");
  if (closed) writeFileSync(join(card, "closed"), "");
  for (const path of [join(card, "tmp", "deps", "index.js"), join(card, "report.md")])
    backdate(path, ageDays);
  if (closed) backdate(join(card, "closed"), ageDays);
  return card;
}

test("tidy removes only what is closed and old: an open card is never touched, a closed card keeps its evidence for seven days, and old compile cache entries go", () => {
  const dir = tempDir("fleet-host-dir-");
  const open = seedCard(dir, "c-2", 90, false);
  const justClosed = seedCard(dir, "c-3", 1, true);
  const longClosed = seedCard(dir, "c-4", 8, true);
  const stranger = join(dir, "scratch", "notes");
  mkdirSync(stranger, { recursive: true });
  writeFileSync(join(stranger, "keep.txt"), "not a card folder");
  backdate(join(stranger, "keep.txt"), 90);
  const outside = tempDir("fleet-outside-");
  mkdirSync(join(outside, "tmp"));
  writeFileSync(join(outside, "precious.txt"), "outside the scratch root");
  writeFileSync(join(outside, "tmp", "precious.txt"), "outside the scratch root");
  writeFileSync(join(outside, "closed"), "");
  backdate(join(outside, "closed"), 90);
  symlinkSync(outside, join(dir, "scratch", "c-5"));
  const cache = join(dir, "node-compile-cache", "v24.0.0-x64-aaaa-1000");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "fresh"), "entry");
  writeFileSync(join(cache, "stale"), "entry");
  backdate(join(cache, "stale"), 3);
  const before = listing(open);

  const out = parseRecord(
    fleet(["scratch", "--tidy", "--json"], { FLEET_HOST_DIR: dir }).trim().split("\n").at(-1) ?? "",
  );

  assert.deepEqual(out["tidied"], { cacheFiles: 1, cards: ["c-4"] });
  assert.deepEqual(listing(open), before);
  assert.deepEqual(listing(justClosed), ["closed", "report.md"]);
  assert.deepEqual(readdirSync(join(dir, "scratch")).sort(), ["c-2", "c-3", "c-5", "notes"]);
  assert.equal(readFileSync(join(stranger, "keep.txt"), "utf8"), "not a card folder");
  assert.deepEqual(listing(outside), ["closed", "precious.txt", "tmp/", "tmp/precious.txt"]);
  assert.deepEqual(readdirSync(cache), ["fresh"]);
  assert.equal(existsSync(longClosed), false);

  const again = parseRecord(
    fleet(["scratch", "--tidy", "--json"], { FLEET_HOST_DIR: dir }).trim().split("\n").at(-1) ?? "",
  );
  assert.deepEqual(again["tidied"], { cacheFiles: 0, cards: [] });
});

test("tidy with no fleet folder yet does nothing and succeeds, at the default place under the home folder", () => {
  const empty = tempDir("fleet-empty-home-");
  const out = parseRecord(
    fleet(["scratch", "--tidy", "--json"], { HOME: empty, FLEET_HOST_DIR: "" })
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(out["tidied"], { cacheFiles: 0, cards: [] });
  const cache = join(empty, ".fleet", "node-compile-cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stale"), "entry");
  backdate(join(cache, "stale"), 3);
  const next = parseRecord(
    fleet(["scratch", "--tidy", "--json"], { HOME: empty, FLEET_HOST_DIR: "" })
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(next["tidied"], { cacheFiles: 1, cards: [] });
});

test("scratch reports the use of the filesystems it writes to, and names the largest directories by inodes or by space", () => {
  const dir = tempDir("fleet-host-dir-");
  const tree = tempDir("fleet-tree-");
  for (const [name, files] of [
    ["many-small", 30],
    ["some", 10],
    ["few", 3],
  ] as const) {
    mkdirSync(join(tree, name));
    for (let index = 0; index < files; index += 1)
      writeFileSync(join(tree, name, `f${String(index)}`), "x");
  }
  writeFileSync(join(tree, "few", "big.bin"), Buffer.alloc(8 * 1024 * 1024, 1));

  const report = parseRecord(fleet(["scratch", "--json"], { FLEET_HOST_DIR: dir }).trim());
  const filesystems = records(report["filesystems"]);
  const tmp = filesystems.find((each) => each["path"] === "/tmp");
  assert.ok(tmp !== undefined, "the report names /tmp");
  const total = Number(tmp["bytesTotal"]);
  const used = Number(tmp["bytesUsed"]);
  const seen = statfsSync("/tmp");
  const expected = (seen.blocks - seen.bfree) * seen.bsize;
  assert.ok(total > 0 && Math.abs(used - expected) < total * 0.05, "bytes used match statfs");
  assert.ok(isRecord(report) && typeof report["host"] === "string");

  const byInodes = parseRecord(
    fleet(["scratch", "--largest", tree, "--by", "inodes", "--json"], {}).trim(),
  );
  assert.deepEqual(
    records(byInodes["largest"]).map((each) => [each["name"], each["inodes"]]),
    [
      [join(tree, "many-small"), 31],
      [join(tree, "some"), 11],
      [join(tree, "few"), 5],
    ],
  );
  const bySpace = parseRecord(
    fleet(["scratch", "--largest", tree, "--by", "space", "--json"], {}).trim(),
  );
  assert.equal(records(bySpace["largest"])[0]?.["name"], join(tree, "few"));
  assert.equal(byInodes["partial"], false);
  assert.equal(typeof byInodes["filesystem"], "string");
});
