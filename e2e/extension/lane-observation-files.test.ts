import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRecord, records } from "../support/json.ts";
import {
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
    let open = false;
    const pump = () => {
      if (!open) return;
      for (let chunk = child.stdout.read() as Buffer | null; chunk !== null;) {
        chunks.push(chunk);
        chunk = child.stdout.read() as Buffer | null;
      }
    };
    child.stdout.on("readable", pump);
    setTimeout(() => {
      open = true;
      pump();
    }, 2_000);
    child.stdout.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

test("a typed maintenance reply larger than the pipe survives exit with its confirmed outcomes", async () => {
  const worktrees = `${here.root}.worktrees`;
  for (let at = 0; at < 600; at++) {
    const broken = join(worktrees, `lane-broken-${String(at).padStart(4, "0")}`, "config");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "lane.json"), "{");
  }
  const reply = await typedReply();
  assert.ok(isRecord(reply));
  assert.ok(typeof reply["failed"] === "string" && reply["failed"].length > 70_000);
  assert.deepEqual(records(reply["outcomes"]), [{ lane: "ops", action: "started" }]);
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
