import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRecord, records } from "../support/json.ts";
import {
  lab,
  here,
  faultLog,
  fleet,
  legacyMaintenance,
  typedMaintenance,
  maintenanceOutcomes,
  maintain,
  workspace,
  action,
  idlePane,
  untilRunning,
} from "../support/lane-observation-lab.ts";

test("root discovery fails in the typed reply but keeps the legacy nonzero exit", async () => {
  const gitDir = join(here.parent, "missing.git");
  const run = (args: readonly string[]) =>
    spawnSync(process.execPath, [here.launch, ...args], {
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, ...lab.env, FLEET_ROOT: "", GIT_DIR: gitDir },
    });
  const capability = run(["--maintenance-outcomes-v1"]);
  assert.equal(capability.status, 0);
  assert.equal(capability.stdout.trim(), "fleet: maintenance outcomes v1");
  const typed = run(typedMaintenance);
  assert.equal(typed.status, 0, typed.stderr);
  const reply = maintenanceOutcomes(typed.stdout);
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], []);
  assert.deepEqual(reply["outcomes"], []);
  assert.match(String(reply["failed"]), /not a git repository/);
  const legacy = run(legacyMaintenance);
  assert.equal(legacy.status, 1);
  assert.equal(legacy.stdout, "");
  assert.match(legacy.stderr, /not a git repository/);
  assert.equal(await workspace("ops"), undefined);
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("local maintenance never starts from a failed, blank, partial, or timed-out workspace read", async () => {
  for (const fault of ["failed", "blank", "partial", "timeout"]) {
    assert.deepEqual(maintain(fault), action("ops", "unread"), fault);
    assert.equal(await workspace("ops"), undefined, fault);
  }
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "partial")), [
    { lane: "ops", state: "unknown", reason: "herdr returned an incomplete workspace list" },
  ]);
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("missing nested pane or process fields neither start nor hold a lane", () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  const home = `${here.root}.worktrees/lane-ops`;
  const startsFile = join(home, "state", "starts");
  const crashHistory = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(startsFile, crashHistory);
  for (const fault of ["panes", "processes"]) {
    assert.deepEqual(maintain(fault), action("ops", "unread"), fault);
    assert.equal(readFileSync(startsFile, "utf8"), crashHistory);
    assert.equal(existsSync(join(home, "state", "stopped")), false);
  }
  const stoppedFile = join(home, "state", "stopped");
  writeFileSync(stoppedFile, "stopped by hand\n");
  assert.throws(() => fleet(["up", "ops", "--json"], "processes"), /incomplete process list/);
  assert.equal(readFileSync(stoppedFile, "utf8"), "stopped by hand\n");
  assert.deepEqual(maintain(), action("ops", "running"));
  assert.equal(existsSync(stoppedFile), false);
});

test("a workspace omitted once neither restarts nor crash-holds a running mate", () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  const home = `${here.root}.worktrees/lane-ops`;
  const startsFile = join(home, "state", "starts");
  const original = readFileSync(startsFile, "utf8");
  const repeated = `${String(Date.now())}\n`.repeat(3);
  for (const history of [original, repeated]) {
    writeFileSync(startsFile, history);
    rmSync(faultLog(), { force: true });
    assert.deepEqual(
      maintenanceOutcomes(fleet(typedMaintenance, "omit-once", "", "5000")),
      action("ops", "running"),
    );
    assert.equal(readFileSync(startsFile, "utf8"), history);
    assert.equal(existsSync(join(home, "state", "stopped")), false);
  }
});

test("status, placement, restart and stop confirm a one-off workspace omission", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  const original = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof original === "string");
  const afterOmission = (args: string[]) => {
    rmSync(faultLog(), { force: true });
    return fleet(args, "omit-once", "", "5000");
  };
  assert.deepEqual(JSON.parse(afterOmission(["status", "--json"])), [
    { lane: "ops", state: "running" },
  ]);
  assert.deepEqual(JSON.parse(afterOmission(["status", "--placement", "--json"])), [
    { lane: "ops", mate: true },
  ]);
  assert.deepEqual(
    JSON.parse(afterOmission(["restart", "ops", "--json"])),
    action("ops", "started"),
  );
  const replaced = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof replaced === "string" && replaced !== original);
  assert.equal(afterOmission(["stop", "ops"]).trim(), "ops: stopped");
  assert.equal(await workspace("ops"), undefined);
});

test("explicit legacy operations cannot mistake absent cwd for a different home", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    home,
    "--label",
    "fleet-ops",
    "--no-focus",
  ]);
  const pane = records([created["root_pane"]])[0]?.["pane_id"];
  const id = records([created["workspace"]])[0]?.["workspace_id"];
  assert.ok(typeof pane === "string" && typeof id === "string");
  const stopped = join(home, "state", "stopped");
  for (const fault of ["cwd", "empty-cwd"])
    assert.throws(() => fleet(["stop", "ops"], fault, pane), /no root pane cwd/);
  assert.equal(existsSync(stopped), false);
  writeFileSync(stopped, "stopped by hand\n");
  for (const fault of ["cwd", "empty-cwd"])
    assert.throws(() => fleet(["restart"], fault, pane), /no root pane cwd/);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [
    { lane: "ops", state: "stopped", reason: "stopped by hand" },
  ]);
  assert.equal(fleet(["stop", "ops"]).trim(), "ops: stopped");
  assert.equal(
    records((await lab.run(["workspace", "list"]))["workspaces"]).some(
      (row) => row["workspace_id"] === id,
    ),
    false,
  );
});

test("home matching needs the mate's cwd, not the cwd of an unrelated split", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    home,
    "--label",
    "2ndmate-ops",
    "--no-focus",
  ]);
  const root = records([created["root_pane"]])[0]?.["pane_id"];
  assert.ok(typeof root === "string");
  const id = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof id === "string");
  await lab.run(["workspace", "rename", id, "fleet-ops"]);
  assert.deepEqual(maintain("cwd", root), action("ops", "unread"));
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [{ lane: "ops", state: "down" }]);
  await lab.run(["workspace", "rename", id, "2ndmate-ops"]);

  assert.deepEqual(maintain("cwd", root), action("ops", "started"));
  await untilRunning("ops");
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "cwd", root)), [
    { lane: "ops", state: "running" },
  ]);
  const placement = ["status", "--placement", "--json"];
  assert.throws(() => fleet(placement, "cwd", root), /no root pane cwd/);

  const added = await lab.run(["pane", "split", root, "--direction", "right", "--no-focus"]);
  const split = records([added["pane"]])[0]?.["pane_id"];
  assert.ok(typeof split === "string");
  assert.deepEqual(maintain("cwd", split), action("ops", "running"));
  assert.throws(() => fleet(placement, "cwd", split), /cannot verify the root pane/);
  assert.throws(() => fleet(placement, "cwd", root), /cannot verify the root pane/);

  const starts = join(home, "state", "starts");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  for (const fault of ["split-only", "duplicate", "foreign"]) {
    assert.deepEqual(maintain(fault, split), action("ops", "unread"), fault);
    assert.throws(() => fleet(placement, fault, split), /incomplete pane list/);
    assert.equal(readFileSync(starts, "utf8"), history);
    assert.equal(existsSync(join(home, "state", "stopped")), false);
  }
  await lab.run(["pane", "close", split]);
  assert.deepEqual(JSON.parse(fleet(placement)), [{ lane: "ops", mate: true }]);
});

test("an idle split workspace is unread until only one pane remains", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    home,
    "--label",
    "2ndmate-ops",
    "--no-focus",
  ]);
  const root = records([created["root_pane"]])[0]?.["pane_id"];
  assert.ok(typeof root === "string");
  const added = await lab.run(["pane", "split", root, "--direction", "right", "--no-focus"]);
  const split = records([added["pane"]])[0]?.["pane_id"];
  assert.ok(typeof split === "string");
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(existsSync(join(home, "state", "starts")), false);
  await lab.run(["pane", "close", split]);
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("restart-all restarts a held current-title mate in a non-first pane", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const before = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof before === "string");
  const added = await lab.run([
    "pane",
    "split",
    root,
    "--direction",
    "right",
    "--cwd",
    home,
    "--no-focus",
  ]);
  const split = records([added["pane"]])[0]?.["pane_id"];
  assert.ok(typeof split === "string");
  const stopped = join(home, "state", "stopped");
  writeFileSync(stopped, "stopped by hand\n");
  assert.throws(() => fleet(["restart", "--json"]), /no Pi observed in the lane home/);
  assert.equal((await workspace("ops"))?.["workspace_id"], before);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "pi-in-split", split)), [
    { lane: "ops", state: "running" },
  ]);
  assert.deepEqual(
    JSON.parse(fleet(["restart", "--json"], "pi-in-split", split, "5000")),
    action("ops", "started"),
  );
  const after = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof after === "string" && after !== before);
  assert.equal(existsSync(stopped), false);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [{ lane: "ops", state: "running" }]);
});

test("restart-all keeps a held lane stopped when its idle current pane precedes a running legacy workspace", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const legacy = await idlePane("ops", home, "fleet-ops");
  await idlePane("ops", home);
  const stopped = join(home, "state", "stopped");
  writeFileSync(stopped, "stopped by hand\n");
  const labels = async () =>
    records((await lab.run(["workspace", "list"]))["workspaces"]).map((row) => row["label"]);
  assert.deepEqual(await labels(), ["fleet-ops", "2ndmate-ops"]);
  assert.match(fleet(["restart"], "pi-in-split", legacy), /ops: stopped: stopped by hand/);
  assert.deepEqual(await labels(), ["fleet-ops", "2ndmate-ops"]);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
});
