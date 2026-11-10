import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { isRecord, parseRecord } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";
import {
  backdate,
  deadPid,
  DISPATCH,
  fleetAsync,
  listing,
  lockCard,
  ownerLine,
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

const sleeper = (seconds: number) => spawn("sleep", [String(seconds)], { stdio: "ignore" });
const running = (child: ReturnType<typeof sleeper>): boolean =>
  child.exitCode === null && child.signalCode === null;

function seedClosedCard(hostDir: string): string {
  const card = join(hostDir, "scratch", "c-1");
  mkdirSync(join(card, "tmp"), { recursive: true });
  writeFileSync(join(card, "closed"), "");
  writeFileSync(join(card, "report.md"), "earlier evidence");
  return card;
}

function tidiedCards(out: string): unknown[] {
  const tidied = parseRecord(out.trim().split("\n").at(-1) ?? "")["tidied"];
  return isRecord(tidied) && Array.isArray(tidied["cards"]) ? tidied["cards"] : [];
}

test("the tidy leaves a card whose lock a live process holds, and takes a lock over only when its holder is gone or it is over a minute old", () => {
  const dir = tempDir("fleet-host-dir-");
  const holder = sleeper(600);
  try {
    const pid = holder.pid ?? 0;
    const held = seedCard(dir, "c-4", 8, true);
    const lock = lockCard(dir, 4, pid);
    assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 0, cards: [] });
    assert.equal(existsSync(held), true);
    assert.equal(readFileSync(join(lock, "owner"), "utf8"), ownerLine(pid));

    backdate(lock, 120 / 86_400);
    assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 0, cards: ["c-4"] });
    assert.equal(existsSync(held), false);
    assert.equal(existsSync(lock), false);

    const orphaned = seedCard(dir, "c-5", 8, true);
    const abandoned = lockCard(dir, 5, deadPid());
    assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 0, cards: ["c-5"] });
    assert.equal(existsSync(orphaned), false);
    assert.equal(existsSync(abandoned), false);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("two tidies that start together over a stale lock both finish, and the card's folder goes once", async () => {
  const dir = tempDir("fleet-host-dir-");
  const folder = seedCard(dir, "c-6", 8, true);
  const lock = lockCard(dir, 6, deadPid());
  const args = ["scratch", "--tidy", "--json"];
  const runs = await Promise.all([
    fleetAsync(args, { FLEET_HOST_DIR: dir }),
    fleetAsync(args, { FLEET_HOST_DIR: dir }),
  ]);
  assert.deepEqual(runs.flatMap(tidiedCards), ["c-6"]);
  assert.equal(existsSync(folder), false);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(join(dir, "scratch")), []);
});

test("a reopen waits for the card's lock, then gives the worker a live temp folder that no mark and no later tidy takes away", async () => {
  const { h, mate } = parts;
  const hostDir = join(home, ".fleet");
  const card = seedClosedCard(hostDir);
  const holder = sleeper(3);
  try {
    const lock = lockCard(hostDir, 1, holder.pid ?? 0);
    let holderRunningAtDispatch = true;
    h.onModel(() => ({ tool: "board", args: {} }), "mate");
    h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
    h.onModel(() => {
      holderRunningAtDispatch = running(holder);
      return { text: "dispatched" };
    }, "mate");
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
    await connected(h);
    mate.prompt("run the tests");
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);

    assert.equal(holderRunningAtDispatch, false, "the reopen did not finish while the lock held");
    assert.deepEqual(withoutJiti(listing(card)), ["report.md", "tmp/"]);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(tidyByHand(hostDir)["tidied"], { cacheFiles: 0, cards: [] });
    assert.deepEqual(withoutJiti(listing(card)), ["report.md", "tmp/"]);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a reopen that cannot get the lock fails the dispatch, starts no worker, and leaves the folder as it was", async () => {
  const { h, mate, lab } = parts;
  const hostDir = join(home, ".fleet");
  const card = seedClosedCard(hostDir);
  const holder = sleeper(600);
  try {
    const pid = holder.pid ?? 0;
    const lock = lockCard(hostDir, 1, pid);
    h.onModel(() => ({ tool: "board", args: {} }), "mate");
    h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
    h.onModel(() => ({ text: "the dispatch failed" }), "mate");
    await connected(h);
    mate.prompt("run the tests");
    const results = toolResults(await h.waitForCall(2, "mate", WORKER_WAIT_MS));

    const named = `cannot reopen c-1: its scratch folder ${card} is locked by ${ownerLine(pid).trim()} (lock ${lock})`;
    assert.ok((results.at(-1) ?? "").includes(named), results.at(-1));
    assert.deepEqual(await workersOf(lab), []);
    assert.deepEqual(withoutJiti(listing(card)), ["closed", "report.md", "tmp/"]);
    assert.equal(readFileSync(join(lock, "owner"), "utf8"), ownerLine(pid));
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a close that cannot get the card's lock still closes the card, and leaves its scratch folder as it was", async () => {
  const { h, mate } = parts;
  const hostDir = join(home, ".fleet");
  const card = join(hostDir, "scratch", "c-1");
  const holder = sleeper(600);
  try {
    let whileOpen: string[] = [];
    let afterClose: string[] = [];
    h.onModel(() => ({ tool: "board", args: {} }), "mate");
    h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
    h.onModel(() => ({ text: "dispatched" }), "mate");
    h.onModel(() => ({ tool: "bash", args: { command: WORKER_SCRIPT } }), "worker");
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
    h.onModel(() => {
      whileOpen = withoutJiti(listing(card));
      lockCard(hostDir, 1, holder.pid ?? 0);
      return { tool: "close", args: { card: 1, summary: "Done." } };
    }, "mate");
    h.onModel(() => {
      afterClose = withoutJiti(listing(card));
      return { text: "closed" };
    }, "mate");
    await connected(h);
    mate.prompt("run the tests");
    const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));

    assert.equal(results.at(-1), "c-1 is done.");
    assert.ok(whileOpen.includes("tmp/clone.txt") && whileOpen.includes("report.md"));
    assert.deepEqual(afterClose, whileOpen);
  } finally {
    holder.kill("SIGKILL");
  }
});
