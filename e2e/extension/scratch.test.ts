import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { tempDir } from "../support/run-root.ts";
import {
  closedFoldersOf,
  DISPATCH,
  listing,
  nameOf,
  scratchOf,
  seedClosed,
  tidyByHand,
  WATCHER_SCRIPT,
  withoutJiti,
  WORKER_SCRIPT,
} from "../support/scratch-files.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

const EVIDENCE = [
  "env.txt",
  ...(process.platform === "linux" ? ["pi-environ.txt"] : []),
  "probe.cjs",
  "report.md",
];

let parts: DispatchLab;
let home: string;
let hostDir: string;
let card: string;
beforeEach(async () => {
  home = tempDir("fleet-host-home-");
  hostDir = join(home, ".fleet");
  card = join(scratchOf(hostDir), "c-1");
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

const closedOf = (): string => {
  const [only, ...more] = closedFoldersOf(hostDir, 1);
  assert.ok(only !== undefined && more.length === 0, "exactly one closed folder");
  return join(scratchOf(hostDir), only);
};

function dispatchAndWait(): void {
  const { h } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
}

test("a worker starts with its scratch, temp, and compile cache on disk under the host's fleet folder, and close removes its temp folder at once and keeps its evidence in a closed folder", async () => {
  const { h, mate } = parts;
  let whileOpen: string[] = [];
  dispatchAndWait();
  h.onModel(() => ({ tool: "bash", args: { command: WORKER_SCRIPT } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => {
    whileOpen = withoutJiti(listing(card));
    return { tool: "close", args: { card: 1, summary: "Done." } };
  }, "mate");
  await connected(h);
  mate.prompt("run the tests");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));

  assert.deepEqual(whileOpen, [...EVIDENCE, "tmp/", "tmp/clone.txt"].sort());
  assert.equal(results.at(-1), "c-1 is done.");
  assert.equal(existsSync(card), false);
  const closed = closedOf();
  assert.deepEqual(listing(closed), EVIDENCE);
  const env = readFileSync(join(closed, "env.txt"), "utf8").trim().split("\n");
  assert.deepEqual(env, [card, join(card, "tmp"), join(hostDir, "node-compile-cache")]);
  assert.notEqual(env[1], process.env["TMPDIR"]);
  if (process.platform === "linux") {
    assert.deepEqual(readFileSync(join(closed, "pi-environ.txt"), "utf8").trim().split("\n"), [
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
  assert.deepEqual(tidyByHand(hostDir)["tidied"], { cacheFiles: 0, cards: [] });
  assert.deepEqual(listing(closed), EVIDENCE);
});

test("a card that wrote nothing but temp files leaves no folder at all after close", async () => {
  const { h, mate } = parts;
  dispatchAndWait();
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("run the tests");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));

  assert.equal(results.at(-1), "c-1 is done.");
  assert.deepEqual(
    readdirSync(scratchOf(hostDir)).filter((name) => name.startsWith("c-1")),
    [],
  );
});

test("dispatching a card again brings its closed folder back as the card's folder with its evidence, and a tidy afterwards removes none of it", async () => {
  const { h, mate } = parts;
  const closed = seedClosed(hostDir, 1, 30, "earlier evidence");
  dispatchAndWait();
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  await connected(h);
  mate.prompt("run the tests");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);

  assert.equal(existsSync(closed), false);
  assert.deepEqual(closedFoldersOf(hostDir, 1), []);
  assert.deepEqual(withoutJiti(listing(card)), ["report.md", "tmp/"]);
  assert.deepEqual(tidyByHand(hostDir)["tidied"], { cacheFiles: 0, cards: [] });
  assert.deepEqual(withoutJiti(listing(card)), ["report.md", "tmp/"]);
  assert.equal(readFileSync(join(card, "report.md"), "utf8"), "earlier evidence");
});

test("with several closed folders of one card, a dispatch brings back the latest, and the tidy then removes only the ones that are a week old", async () => {
  const { h, mate } = parts;
  seedClosed(hostDir, 1, 9, "oldest");
  const middle = seedClosed(hostDir, 1, 5, "middle");
  seedClosed(hostDir, 1, 3, "newest");
  dispatchAndWait();
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  await connected(h);
  mate.prompt("run the tests");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);

  assert.equal(readFileSync(join(card, "report.md"), "utf8"), "newest");
  assert.equal(existsSync(join(card, "tmp")), true);
  assert.equal(closedFoldersOf(hostDir, 1).length, 2);
  assert.deepEqual(tidyByHand(hostDir)["tidied"], { cacheFiles: 0, cards: ["c-1"] });
  assert.deepEqual(closedFoldersOf(hostDir, 1), [nameOf(middle)]);
  assert.deepEqual(tidyByHand(hostDir)["tidied"], { cacheFiles: 0, cards: [] });
  assert.equal(readFileSync(join(card, "report.md"), "utf8"), "newest");
  assert.equal(existsSync(join(card, "tmp")), true);
});

test("a dispatch after the tidy has taken the card's only closed folder starts a fresh folder with a temp folder and no evidence", async () => {
  const { h, mate } = parts;
  const closed = seedClosed(hostDir, 1, 8, "gone with the tidy");
  assert.deepEqual(tidyByHand(hostDir)["tidied"], { cacheFiles: 0, cards: ["c-1"] });
  assert.equal(existsSync(closed), false);
  dispatchAndWait();
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  await connected(h);
  mate.prompt("run the tests");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);

  assert.deepEqual(withoutJiti(listing(card)), ["tmp/"]);
  assert.deepEqual(closedFoldersOf(hostDir, 1), []);
});

test("a close that cannot finish leaves the card's folder as it was, with no closed folder, and a tidy by hand removes nothing from it", async () => {
  const { h, mate, cardd } = parts;
  let whileOpen: string[] = [];
  let afterClose: string[] = [];
  let afterTidy: string[] = [];
  let tidied: unknown;
  dispatchAndWait();
  h.onModel(() => ({ tool: "bash", args: { command: WORKER_SCRIPT } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => {
    whileOpen = withoutJiti(listing(card));
    cardd.refuseCloseRecord();
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

  assert.match(results.at(-1) ?? "", /entries refuse the close record/);
  assert.doesNotMatch(results.at(-1) ?? "", /is done/);
  assert.ok(whileOpen.includes("tmp/clone.txt") && whileOpen.includes("report.md"));
  assert.deepEqual(afterClose, whileOpen);
  assert.deepEqual(tidied, { cacheFiles: 0, cards: [] });
  assert.deepEqual(afterTidy, whileOpen);
  assert.deepEqual(closedFoldersOf(hostDir, 1), []);
});

test("a card whose newest attempt cannot be retired keeps its folder as it was, and the close that finishes it renames the folder once", async () => {
  const { h, mate, cardd, mainToken } = parts;
  const down = join(h.dir, "far-down");
  let whileOpen: string[] = [];
  let afterFailure: string[] = [];
  const dropIt = { tool: "close", args: { card: 1, summary: "Dropped.", landed: false } };
  dispatchAndWait();
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
    return dropIt;
  }, "mate");
  h.onModel(() => {
    afterFailure = withoutJiti(listing(card));
    assert.deepEqual(closedFoldersOf(hostDir, 1), []);
    rmSync(down);
    return dropIt;
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
  assert.equal(existsSync(card), false);
  assert.deepEqual(listing(closedOf()), EVIDENCE);
});

test("a card with two attempts on one host keeps its folder while the newest worker still runs in it, and close renames it only after both are stopped", async () => {
  const { h, mate, cardd, lab } = parts;
  const dropIt = { tool: "close", args: { card: 1, summary: "Dropped.", landed: false } };
  const watching = join(card, "watch.log");
  let beforeClose: string[] = [];
  let closedBefore: string[] = ["unset"];
  let afterClose: { folder: string[]; log: string; alive: boolean } | undefined;
  dispatchAndWait();
  h.onModel(() => ({ tool: "bash", args: { command: WORKER_SCRIPT } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => ({ text: "the first attempt is done" }), "worker");
  h.onModel(() => {
    cardd.endAttemptsByHand(1);
    return { tool: "dispatch", args: DISPATCH };
  }, "mate");
  h.onModel(() => ({ text: "dispatched again" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command: WATCHER_SCRIPT } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "watching" } }), "worker");
  h.onModel(async () => {
    const deadline = Date.now() + WORKER_WAIT_MS;
    while (!(existsSync(watching) && readFileSync(watching, "utf8").includes("up"))) {
      assert.ok(Date.now() < deadline, "the newest worker's watcher never started");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    beforeClose = withoutJiti(listing(card));
    closedBefore = closedFoldersOf(hostDir, 1);
    return dropIt;
  }, "mate");
  h.onModel(() => {
    const closed = closedOf();
    const pid = Number(readFileSync(join(closed, "watcher.pid"), "utf8"));
    afterClose = {
      folder: listing(closed),
      log: readFileSync(join(closed, "watch.log"), "utf8"),
      alive: processAlive(pid),
    };
    return { text: "closed" };
  }, "mate");
  await connected(h);
  mate.prompt("run the tests");
  const results = toolResults(await h.waitForCall(6, "mate", WORKER_WAIT_MS));

  assert.equal(results.at(-1), "c-1 is dropped.");
  assert.ok(beforeClose.includes("tmp/") && beforeClose.includes("watch.log"));
  assert.deepEqual(closedBefore, [], "nothing was renamed while the newest worker ran");
  assert.ok(afterClose !== undefined);
  assert.deepEqual(afterClose.folder, [...EVIDENCE, "watch.log", "watcher.pid"].sort());
  assert.deepEqual(
    new Set(afterClose.log.trim().split("\n")),
    new Set(["up"]),
    "the newest worker's process never saw its temp folder go",
  );
  assert.equal(afterClose.alive, false, "the newest worker's process was stopped by close");
  assert.deepEqual(await workersOf(lab), []);
  assert.equal(existsSync(card), false);
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
