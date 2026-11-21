import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRecord, records } from "../support/json.ts";
import {
  addLane,
  idlePane,
  here,
  fleet,
  fleetEnv,
  legacyMaintenance,
  maintain,
  typedMaintenance,
  workspace,
  action,
} from "../support/lane-observation-lab.ts";

const lane = () => `${here.root}.worktrees/lane-ops`;

function typedReply(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [here.launch, ...typedMaintenance], {
      env: fleetEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.once("error", reject);
    const chunks: Buffer[] = [];
    child.stdout.once("readable", () => {
      child.stdout.removeAllListeners("readable");
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    });
    child.stdout.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

test("a typed maintenance reply far larger than the pipe survives exit with its confirmed outcomes", async () => {
  const worktrees = `${here.root}.worktrees`;
  const names: string[] = [];
  for (let at = 0; at < 3000; at++) {
    const suffix = `broken-${String(at).padStart(5, "0")}-${"x".repeat(180)}`;
    names.push(suffix);
    const config = join(worktrees, `lane-${suffix}`, "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "lane.json"), "{");
  }
  const reply = await typedReply();
  assert.ok(isRecord(reply));
  const expected: unknown = reply["expected"];
  assert.ok(Array.isArray(expected));
  assert.deepEqual(expected.map(String).sort(), ["ops", ...names].sort());
  const failed = String(reply["failed"]);
  assert.ok(failed.length > 1_000_000);
  for (const name of [names[0], names[1499], names[2999]])
    assert.ok(failed.includes(`lane ${String(name)} could not be read`));
  assert.deepEqual(records(reply["outcomes"]), [{ lane: "ops", action: "started" }]);
});

function copyHome(name: string, edit: (config: Record<string, unknown>) => void): string {
  const home = `${here.root}.worktrees/lane-${name}`;
  const raw: unknown = JSON.parse(readFileSync(join(lane(), "config", "lane.json"), "utf8"));
  assert.ok(isRecord(raw));
  edit(raw);
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "lane.json"), JSON.stringify(raw));
  return home;
}

test("homes claiming one lane are a single unread record under that lane, and a sibling still starts", async () => {
  addLane("zz");
  const home = lane();
  const backup = copyHome("ops-backup", () => undefined);
  const old = copyHome("ops-old", () => undefined);
  const reply: unknown = JSON.parse(fleet(typedMaintenance));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["zz", "ops"]);
  assert.match(
    String(reply["failed"]),
    /lane ops is claimed by more than one home \(lane-ops, lane-ops-backup, lane-ops-old\)/,
  );
  assert.deepEqual(
    records(reply["outcomes"]).map((row) => [row["lane"], row["action"]]),
    [["zz", "started"]],
  );
  assert.equal(await workspace("ops"), undefined);
  for (const each of [home, backup, old])
    assert.equal(existsSync(join(each, "state", "starts")), false);
  const readable = copyHome("ops-readable", (config) => {
    config["lane"] = "ops-old";
  });
  const rows: unknown = JSON.parse(fleet(["status", "--json"]));
  assert.deepEqual(
    records(rows).map((row) => [row["lane"], row["state"]]),
    [
      ["ops-old", "down"],
      ["zz", "running"],
      ["ops", "unknown"],
    ],
  );
  rmSync(readable, { recursive: true });
  assert.throws(() => fleet(["up", "ops"]), /lane ops is claimed by more than one home/);
  rmSync(backup, { recursive: true });
  rmSync(old, { recursive: true });
  assert.deepEqual(maintain(), [
    { lane: "ops", action: "started" },
    { lane: "zz", action: "running" },
  ]);
});

test("a blank lane name is unread under its directory, never started, and keeps sibling outcomes", () => {
  addLane("zz");
  const blank = copyHome("blank", (config) => {
    config["lane"] = " ";
  });
  const reply: unknown = JSON.parse(fleet(typedMaintenance));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops", "zz", "blank"]);
  assert.match(String(reply["failed"]), /lane blank could not be read: .* needs "lane"/);
  assert.deepEqual(
    records(reply["outcomes"]).map((row) => [row["lane"], row["action"]]),
    [
      ["ops", "started"],
      ["zz", "started"],
    ],
  );
  assert.equal(existsSync(join(blank, "state", "starts")), false);
});

test("an unreadable root config is reported by typed maintenance without stopping verified second mates", async () => {
  const config = join(here.root, "config", "lane.json");
  const good = readFileSync(config, "utf8");
  writeFileSync(config, "{");
  assert.throws(() => fleet(legacyMaintenance), /not valid JSON/);
  assert.equal(await workspace("ops"), undefined);
  const reply: unknown = JSON.parse(fleet(typedMaintenance));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops"]);
  assert.match(String(reply["failed"]), /root lane config could not be read: .*not valid JSON/);
  assert.deepEqual(records(reply["outcomes"]), [{ lane: "ops", action: "started" }]);
  assert.throws(() => fleet(["up"]), /not valid JSON/);
  writeFileSync(config, good);
  assert.deepEqual(maintain(), action("ops", "running"));
});

test("a dangling lane config, stop marker or start history is unread, never absent", async () => {
  const home = lane();
  const missing = join(here.parent, "missing-target");
  const config = join(home, "config", "lane.json");
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  for (const marker of ["stopped", "starts"]) {
    symlinkSync(missing, join(state, marker));
    assert.deepEqual(maintain(), action("ops", "unread"), marker);
    const rows: unknown = JSON.parse(fleet(["status", "--json"]));
    assert.equal(records(rows)[0]?.["state"], "unknown", marker);
    assert.equal(await workspace("ops"), undefined, marker);
    rmSync(join(state, marker));
  }
  rmSync(config);
  symlinkSync(missing, config);
  const reply: unknown = JSON.parse(fleet(typedMaintenance));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops"]);
  assert.ok(typeof reply["failed"] === "string" && reply["failed"].includes("ops"));
  assert.equal(existsSync(join(state, "starts")), false);
});

test("a workspace row without a pane count is unread and is never closed by stop or restart", async () => {
  const home = lane();
  const root = await idlePane("ops", home);
  const stopped = join(home, "state", "stopped");
  const before = await workspace("ops");
  assert.ok(typeof before?.["workspace_id"] === "string");
  assert.throws(() => fleet(["stop", "ops"], "no-count", root), /no pane count/);
  assert.throws(() => fleet(["restart", "ops"], "no-count", root), /no pane count/);
  assert.equal(existsSync(stopped), false);
  assert.equal((await workspace("ops"))?.["workspace_id"], before["workspace_id"]);
  assert.equal(fleet(["stop", "ops"]).trim(), "ops: stopped");
  assert.equal(await workspace("ops"), undefined);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
});

test("a home that becomes readable after the sweep's snapshot waits for the next sweep's preflight", async () => {
  const fix = addLane("fix");
  const config = join(fix, "config", "lane.json");
  const good = readFileSync(config, "utf8");
  writeFileSync(join(fix, "config", "optchat.json"), JSON.stringify({ profile: "ghost" }));
  writeFileSync(config, "{");
  writeFileSync(`${config}.next`, good);
  const reply: unknown = JSON.parse(fleet(typedMaintenance, "swap-config", config));
  assert.ok(existsSync(`${config}.swapped`));
  assert.equal(readFileSync(config, "utf8"), good);
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops", "fix"]);
  assert.match(String(reply["failed"]), /lane fix could not be read: .*not valid JSON/);
  assert.deepEqual(records(reply["outcomes"]), [{ lane: "ops", action: "started" }]);
  assert.equal(await workspace("fix"), undefined);
  assert.equal(existsSync(join(fix, "state", "starts")), false);
  const next: unknown = JSON.parse(fleet(typedMaintenance));
  assert.ok(isRecord(next));
  assert.match(String(next["failed"]), /optchat of lane fix has no AGENTS.md and config.json/);
  assert.equal(await workspace("fix"), undefined);
  assert.equal(existsSync(join(fix, "state", "starts")), false);
});

test("a lane claim that changes after the sweep checked it is unread and never acted on", async () => {
  const home = lane();
  const config = join(home, "config", "lane.json");
  const good = readFileSync(config, "utf8");
  const changed: unknown = JSON.parse(good);
  assert.ok(isRecord(changed));
  changed["args"] = ["--changed"];
  for (const next of ["{", JSON.stringify(changed)]) {
    rmSync(`${config}.swapped`, { force: true });
    writeFileSync(`${config}.next`, next);
    const reply: unknown = JSON.parse(fleet(typedMaintenance, "swap-config", config));
    assert.ok(existsSync(`${config}.swapped`));
    assert.ok(isRecord(reply));
    assert.deepEqual(reply["expected"], ["ops"]);
    assert.deepEqual(records(reply["outcomes"]), [{ lane: "ops", action: "unread" }]);
    assert.equal(await workspace("ops"), undefined);
    assert.equal(existsSync(join(home, "state", "starts")), false);
    assert.equal(existsSync(join(home, "state", "stopped")), false);
    writeFileSync(config, good);
  }
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("a competing home that becomes readable after the sweep's snapshot makes the lane ambiguous and unread", async () => {
  const home = lane();
  const rival = copyHome("ops-backup", () => undefined);
  const rivalConfig = join(rival, "config", "lane.json");
  const claim = readFileSync(rivalConfig, "utf8");
  const selected = readFileSync(join(home, "config", "lane.json"), "utf8");
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const history = `${String(Date.now())}\n`.repeat(3);
  for (const recorded of [history, undefined]) {
    writeFileSync(rivalConfig, "{");
    writeFileSync(`${rivalConfig}.next`, claim);
    rmSync(`${rivalConfig}.swapped`, { force: true });
    rmSync(starts, { force: true });
    if (recorded !== undefined) writeFileSync(starts, recorded);
    const reply: unknown = JSON.parse(fleet(typedMaintenance, "swap-config", rivalConfig));
    assert.ok(existsSync(`${rivalConfig}.swapped`));
    assert.equal(readFileSync(join(home, "config", "lane.json"), "utf8"), selected);
    assert.ok(isRecord(reply));
    assert.deepEqual(reply["expected"], ["ops", "ops-backup"]);
    assert.match(String(reply["failed"]), /lane ops-backup could not be read: .*not valid JSON/);
    assert.deepEqual(records(reply["outcomes"]), [{ lane: "ops", action: "unread" }]);
    assert.equal(await workspace("ops"), undefined);
    assert.equal(existsSync(stopped), false);
    assert.equal(existsSync(starts), recorded !== undefined);
    if (recorded !== undefined) assert.equal(readFileSync(starts, "utf8"), recorded);
  }
  rmSync(rival, { recursive: true });
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("a lane config that is a writerless FIFO is unread without blocking a healthy sibling", async () => {
  const fix = addLane("fix");
  const config = join(fix, "config", "lane.json");
  rmSync(config);
  execFileSync("mkfifo", [config]);
  const out = execFileSync(process.execPath, [here.launch, ...typedMaintenance], {
    encoding: "utf8",
    env: fleetEnv(),
    timeout: 30_000,
  });
  const reply: unknown = JSON.parse(out);
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops", "fix"]);
  assert.match(String(reply["failed"]), /lane fix could not be read: .*not a regular file/);
  assert.deepEqual(records(reply["outcomes"]), [{ lane: "ops", action: "started" }]);
  assert.equal(await workspace("fix"), undefined);
});

test("a malformed legacy row does not hide a valid current-title workspace", async () => {
  const home = lane();
  await idlePane("ops", home);
  await idlePane("ops", home, "fleet-ops");
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "no-legacy-count")), [
    { lane: "ops", state: "down" },
  ]);
});
