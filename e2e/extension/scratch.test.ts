import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
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
import { isRecord, parseRecord, records } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";
import {
  backdate,
  DISPATCH,
  fleet,
  fleetResult,
  listing,
  seedCard,
  tidyByHand,
  withoutJiti,
  WORKER_SCRIPT,
} from "../support/scratch-files.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

let parts: DispatchLab;
let home: string;
beforeEach(async () => {
  home = tempDir("fleet-host-home-");
  const config = process.env["XDG_CONFIG_HOME"] ?? join(process.env["HOME"] ?? "", ".config");
  parts = await startDispatchLab({
    workerArgs: ["-e", SHELL],
    mate: {
      HOME: home,
      XDG_CONFIG_HOME: config,
      FLEET_HOST_DIR: "",
      FLEET_SCRATCH_LOCK_WAIT_MS: "4000",
    },
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

test("dispatching a card again reopens its folder: the closed mark goes, the evidence stays, and a tidy afterwards removes none of it", async () => {
  const hostDir = join(home, ".fleet");
  const card = join(hostDir, "scratch", "c-1");
  mkdirSync(join(card, "tmp"), { recursive: true });
  writeFileSync(join(card, "closed"), "");
  writeFileSync(join(card, "report.md"), "earlier evidence");
  backdate(join(card, "closed"), 30);
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  await connected(h);
  mate.prompt("run the tests");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  assert.deepEqual(withoutJiti(listing(card)), ["report.md", "tmp/"]);

  assert.deepEqual(tidyByHand(hostDir)["tidied"], { cacheFiles: 0, cards: [] });
  assert.deepEqual(withoutJiti(listing(card)), ["report.md", "tmp/"]);
  assert.equal(readFileSync(join(card, "report.md"), "utf8"), "earlier evidence");
});

test("a close that cannot finish leaves the card's scratch folder as it was, and a tidy by hand removes nothing from it", async () => {
  const { h, mate, cardd } = parts;
  const hostDir = join(home, ".fleet");
  const card = join(hostDir, "scratch", "c-1");
  let whileOpen: string[] = [];
  let afterClose: string[] = [];
  let afterTidy: string[] = [];
  let tidied: unknown;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command: WORKER_SCRIPT } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => {
    whileOpen = withoutJiti(listing(card));
    cardd.breakBrowserTabs();
    return { tool: "close", args: { card: 1, summary: "Done." } };
  }, "mate");
  h.onModel(() => {
    afterClose = withoutJiti(listing(card));
    tidied = tidyByHand(hostDir)["tidied"];
    afterTidy = withoutJiti(listing(card));
    return { text: "close failed" };
  }, "mate");
  await connected(h);
  mate.prompt("run the tests");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));

  assert.match(results.at(-1) ?? "", /browser_tabs/);
  assert.doesNotMatch(results.at(-1) ?? "", /is done/);
  assert.ok(whileOpen.includes("tmp/clone.txt") && whileOpen.includes("report.md"));
  assert.deepEqual(afterClose, whileOpen);
  assert.deepEqual(tidied, { cacheFiles: 0, cards: [] });
  assert.deepEqual(afterTidy, whileOpen);
  assert.equal(existsSync(join(card, "closed")), false);
});

test("a card whose newest attempt cannot be retired keeps its scratch folder, and the close that finishes it clears the folder once", async () => {
  const { h, mate, cardd, mainToken } = parts;
  const hostDir = join(home, ".fleet");
  const card = join(hostDir, "scratch", "c-1");
  const down = join(h.dir, "far-down");
  let whileOpen: string[] = [];
  let afterFailure: string[] = [];
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command: WORKER_SCRIPT } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(async () => {
    whileOpen = withoutJiti(listing(card));
    cardd.endAttemptsByHand(1);
    const begun = await cardd.post(mainToken, "attempt.begin", {
      card: 1,
      host: "far",
      task: "run them again",
    });
    assert.equal(begun.status, 200);
    writeFileSync(down, "down");
    return { tool: "close", args: { card: 1, summary: "Dropped.", landed: false } };
  }, "mate");
  h.onModel(() => {
    afterFailure = withoutJiti(listing(card));
    rmSync(down);
    return { tool: "close", args: { card: 1, summary: "Dropped.", landed: false } };
  }, "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await connected(h);
  mate.prompt("run the tests");
  const results = toolResults(await h.waitForCall(5, "mate", WORKER_WAIT_MS));

  assert.match(results.at(-2) ?? "", /far/);
  assert.doesNotMatch(results.at(-2) ?? "", /is dropped/);
  assert.ok(whileOpen.includes("tmp/clone.txt") && whileOpen.includes("report.md"));
  assert.deepEqual(afterFailure, whileOpen);
  assert.equal(results.at(-1), "c-1 is dropped.");
  assert.deepEqual(listing(card), [
    "closed",
    "env.txt",
    ...(process.platform === "linux" ? ["pi-environ.txt"] : []),
    "probe.cjs",
    "report.md",
  ]);
});

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
  const leftover = join(dir, "scratch", ".removing-4242-c-6");
  mkdirSync(join(leftover, "deps"), { recursive: true });
  writeFileSync(join(leftover, "deps", "index.js"), "x");
  symlinkSync(outside, join(dir, "scratch", ".removing-4242-c-7"));
  const idleLock = join(dir, "scratch", ".lock-c-8.1");
  mkdirSync(idleLock);
  backdate(idleLock, 2);
  mkdirSync(join(dir, "scratch", ".lock-c-8.2"));
  const cache = join(dir, "node-compile-cache", "v24.0.0-x64-aaaa-1000");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "fresh"), "entry");
  writeFileSync(join(cache, "stale"), "entry");
  backdate(join(cache, "stale"), 3);
  const before = listing(open);

  const out = tidyByHand(dir);

  assert.deepEqual(out["tidied"], { cacheFiles: 1, cards: ["c-4"] });
  assert.deepEqual(listing(open), before);
  assert.deepEqual(listing(justClosed), ["closed", "report.md"]);
  assert.deepEqual(readdirSync(join(dir, "scratch")).sort(), [
    ".lock-c-3.1",
    ".lock-c-4.1",
    ".lock-c-8.2",
    ".removing-4242-c-7",
    "c-2",
    "c-3",
    "c-5",
    "notes",
  ]);
  assert.equal(existsSync(leftover), false);
  assert.equal(existsSync(idleLock), false);
  assert.equal(readFileSync(join(stranger, "keep.txt"), "utf8"), "not a card folder");
  assert.deepEqual(listing(outside), ["closed", "precious.txt", "tmp/", "tmp/precious.txt"]);
  assert.deepEqual(readdirSync(cache), ["fresh"]);
  assert.equal(existsSync(longClosed), false);

  assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 0, cards: [] });
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

test("scratch ranks the largest directories of several roots together, and the report lists the roots that share a filesystem", () => {
  const dir = tempDir("fleet-host-dir-");
  const first = tempDir("fleet-root-a-");
  const second = tempDir("fleet-root-b-");
  for (const [root, name, files] of [
    [first, "a-small", 3],
    [first, "a-mid", 10],
    [second, "b-huge", 40],
    [second, "b-big", 25],
    [second, "b-mid", 12],
    [second, "b-few", 5],
  ] as const) {
    mkdirSync(join(root, name));
    for (let index = 0; index < files; index += 1)
      writeFileSync(join(root, name, `f${String(index)}`), "x");
  }

  const together = parseRecord(
    fleet(["scratch", "--largest", first, "--largest", second, "--by", "inodes", "--json"], {})
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(
    records(together["largest"]).map((each) => [each["name"], each["inodes"]]),
    [
      [join(second, "b-huge"), 41],
      [join(second, "b-big"), 26],
      [join(second, "b-mid"), 13],
      [join(first, "a-mid"), 11],
      [join(second, "b-few"), 6],
    ],
  );
  const alone = parseRecord(
    fleet(["scratch", "--largest", first, "--by", "inodes", "--json"], {}).trim(),
  );
  assert.deepEqual(
    records(alone["largest"]).map((each) => each["name"]),
    [join(first, "a-mid"), join(first, "a-small")],
  );

  const report = parseRecord(fleet(["scratch", "--json"], { FLEET_HOST_DIR: dir }).trim());
  const shared = records(report["filesystems"]).find((each) =>
    Array.isArray(each["roots"]) ? each["roots"].includes(dir) : false,
  );
  assert.ok(shared !== undefined, "the host folder is a root of a reported filesystem");
  const roots = shared["roots"];
  assert.ok(Array.isArray(roots));
  assert.equal(shared["path"], roots[0]);
  assert.ok(roots.includes(process.env["TMPDIR"]));
  assert.ok(roots.indexOf(process.env["TMPDIR"]) < roots.indexOf(dir));
  assert.equal(new Set(roots).size, roots.length);
});

test("the directory budget stops the walk: a spent budget returns what was counted, says partial, and leaves the rest unscanned", () => {
  const first = tempDir("fleet-root-a-");
  const second = tempDir("fleet-root-b-");
  const files = 4000;
  for (const root of [first, second]) {
    for (const name of ["x", "y"]) {
      mkdirSync(join(root, name));
      for (let index = 0; index < files; index += 1)
        writeFileSync(join(root, name, `f${String(index)}`), "x");
    }
  }
  const started = Date.now();
  const out = parseRecord(
    fleet(["scratch", "--largest", first, "--largest", second, "--by", "inodes", "--json"], {
      FLEET_SCRATCH_WALK_MS: "1",
    })
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.ok(Date.now() - started < 20_000, "the call returned promptly");
  assert.equal(out["partial"], true);
  assert.ok(
    records(out["largest"]).every((each) => !String(each["name"]).startsWith(second)),
    "the later root was not reached after the budget was spent",
  );
  const counted = records(out["largest"]).map((each) => Number(each["inodes"]));
  assert.ok(counted.length < 4, "the walk stopped before it reached every child");
  assert.ok(
    counted.every((inodes) => inodes < files + 1),
    "no child was counted in full",
  );
});

test("a watched root that cannot be read is skipped and the others still answer, and when none can be read the call fails", () => {
  const first = tempDir("fleet-root-a-");
  mkdirSync(join(first, "a-dir"));
  for (let index = 0; index < 3; index += 1)
    writeFileSync(join(first, "a-dir", `f${String(index)}`), "x");
  const missing = join(first, "does-not-exist");

  const out = parseRecord(
    fleet(["scratch", "--largest", first, "--largest", missing, "--by", "inodes", "--json"], {})
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(
    records(out["largest"]).map((each) => [each["name"], each["inodes"]]),
    [[join(first, "a-dir"), 4]],
  );
  assert.equal(out["partial"], false);

  const none = fleetResult(["scratch", "--largest", missing, "--by", "inodes", "--json"], {});
  assert.notEqual(none.status, 0);
  assert.ok(none.stderr.includes(`none of ${missing} could be read`), none.stderr);
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
