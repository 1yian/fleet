import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRecord, records } from "../support/json.ts";
import {
  addLane,
  here,
  fleet,
  fleetEnv,
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

test("two homes claiming one lane are both unread and never start, while a healthy sibling still does", async () => {
  const sibling = addLane("zz");
  assert.ok(existsSync(join(sibling, "config", "lane.json")));
  const home = lane();
  const copy = `${here.root}.worktrees/lane-ops-backup`;
  mkdirSync(join(copy, "config"), { recursive: true });
  cpSync(join(home, "config", "lane.json"), join(copy, "config", "lane.json"));
  const reply: unknown = JSON.parse(fleet(typedMaintenance));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["zz", "ops", "ops-backup"]);
  assert.match(
    String(reply["failed"]),
    /lane ops is claimed by more than one home \(lane-ops, lane-ops-backup\)/,
  );
  assert.deepEqual(records(reply["outcomes"]), [{ lane: "zz", action: "started" }]);
  assert.equal(await workspace("ops"), undefined);
  assert.equal(existsSync(join(home, "state", "starts")), false);
  assert.equal(existsSync(join(copy, "state", "starts")), false);
  const rows: unknown = JSON.parse(fleet(["status", "--json"]));
  assert.deepEqual(
    records(rows).map((row) => [row["lane"], row["state"]]),
    [
      ["zz", "running"],
      ["ops", "unknown"],
      ["ops-backup", "unknown"],
    ],
  );
  rmSync(copy, { recursive: true });
  assert.deepEqual(maintain(), [
    { lane: "ops", action: "started" },
    { lane: "zz", action: "running" },
  ]);
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
