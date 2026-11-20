import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { isRecord, records } from "../support/json.ts";
import { startMain } from "../support/scratch.ts";
import {
  h,
  lab,
  here,
  addLane,
  faultLog,
  fleet,
  legacyMaintenance,
  typedMaintenance,
  maintenanceOutcomes,
  maintain,
  workspace,
  action,
  idlePane,
} from "../support/lane-observation-lab.ts";

test("legacy split workspaces close by the original pane's home, not by Pi in a split", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  for (const cwd of [here.root, home]) {
    const created = await lab.run([
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      "fleet-ops",
      "--no-focus",
    ]);
    const id = records([created["workspace"]])[0]?.["workspace_id"];
    const root = records([created["root_pane"]])[0]?.["pane_id"];
    assert.ok(typeof id === "string" && typeof root === "string");
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
    const starts = join(home, "state", "starts");
    const history = `${String(Date.now())}\n`.repeat(3);
    writeFileSync(stopped, "stopped by hand\n");
    writeFileSync(starts, history);
    assert.deepEqual(maintain("pi-in-split", split), action("ops", "unread"));
    const status: unknown = JSON.parse(fleet(["status", "--json"], "pi-in-split", split));
    assert.equal(records(status)[0]?.["state"], "unknown");
    assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
    assert.equal(readFileSync(starts, "utf8"), history);
    assert.equal(fleet(["stop", "ops"], "pi-in-split", split).trim(), "ops: stopped");
    const listed = async () => records((await lab.run(["workspace", "list"]))["workspaces"]);
    assert.equal(
      (await listed()).some((row) => row["workspace_id"] === id),
      cwd !== home,
    );
    if (cwd !== home) {
      assert.match(fleet(["restart"], "pi-in-split", split), /ops: stopped: stopped by hand/);
      assert.equal(
        (await listed()).some((row) => row["workspace_id"] === id),
        true,
      );
      await lab.run(["workspace", "close", id]);
    }
  }
});

test("a legacy split listed first cannot mask the current-title lane", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const legacyPane = await idlePane("ops", home, "fleet-ops");
  await lab.run(["pane", "split", legacyPane, "--direction", "right", "--no-focus"]);
  await idlePane("ops", home);
  const labels = async () =>
    records((await lab.run(["workspace", "list"]))["workspaces"]).map((row) => row["label"]);
  assert.deepEqual(await labels(), ["fleet-ops", "2ndmate-ops"]);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [{ lane: "ops", state: "down" }]);
  assert.deepEqual(maintain(), action("ops", "started"));
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [{ lane: "ops", state: "running" }]);
  assert.deepEqual(JSON.parse(fleet(["status", "--placement", "--json"])), [
    { lane: "ops", mate: true },
  ]);
  assert.equal(fleet(["stop", "ops"]).trim(), "ops: stopped");
  assert.deepEqual(await labels(), ["fleet-ops"]);
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(readFileSync(join(home, "state", "stopped"), "utf8"), "stopped by hand\n");
});

test("an omitted current title cannot authorize a legacy start, hold, or close", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  const home = `${here.root}.worktrees/lane-ops`;
  const legacyPane = await idlePane("ops", home, "fleet-ops");
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const afterOmission = (args: string[], title = "2ndmate-ops") => {
    rmSync(faultLog(), { force: true });
    return fleet(args, "omit-title-once", title, "5000");
  };
  assert.deepEqual(JSON.parse(afterOmission(["status", "--json"])), [
    { lane: "ops", state: "running" },
  ]);
  assert.deepEqual(JSON.parse(afterOmission(["status", "--placement", "--json"])), [
    { lane: "ops", mate: true },
  ]);
  const original = readFileSync(starts, "utf8");
  for (const history of [original, `${String(Date.now())}\n`.repeat(3)]) {
    writeFileSync(starts, history);
    assert.deepEqual(
      maintenanceOutcomes(afterOmission(typedMaintenance)),
      action("ops", "running"),
    );
    assert.equal(readFileSync(starts, "utf8"), history);
    assert.equal(existsSync(stopped), false);
  }
  assert.equal(afterOmission(["stop", "ops"]).trim(), "ops: stopped");
  assert.equal(await workspace("ops"), undefined);
  const panes = await lab.run(["pane", "list"]);
  assert.ok(records(panes["panes"]).some((row) => row["pane_id"] === legacyPane));
  assert.deepEqual(
    maintenanceOutcomes(afterOmission(typedMaintenance, "fleet-ops")),
    action("ops", "unread"),
  );
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
  assert.deepEqual(maintain(), [{ lane: "ops", action: "stopped", detail: "stopped by hand" }]);
});

test("a pane disappearing between list and process info leaves the lane unread", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  const home = `${here.root}.worktrees/lane-ops`;
  const starts = join(home, "state", "starts");
  const original = readFileSync(starts, "utf8");
  const crashHistory = `${String(Date.now())}\n`.repeat(3);
  for (const history of [original, crashHistory]) {
    const id = (await workspace("ops"))?.["workspace_id"];
    assert.ok(typeof id === "string");
    writeFileSync(starts, history);
    assert.deepEqual(maintain("vanished", id), action("ops", "unread"));
    assert.equal(await workspace("ops"), undefined);
    assert.equal(readFileSync(starts, "utf8"), history);
    assert.equal(existsSync(join(home, "state", "stopped")), false);
    writeFileSync(starts, original);
    assert.deepEqual(maintain(), action("ops", "started"));
  }
  const id = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof id === "string");
  const rows: unknown = JSON.parse(fleet(["status", "--json"], "vanished", id));
  assert.equal(records(rows)[0]?.["state"], "unknown");
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [{ lane: "ops", state: "down" }]);
});

test("a pane split opened while the pane is being inspected leaves the lane unread", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const panesOf = async () =>
    records((await lab.run(["pane", "list"]))["panes"]).map((row) => row["pane_id"]);
  const rearm = async () => {
    rmSync(`${faultLog()}.split`, { force: true });
    const ids = await panesOf();
    assert.deepEqual(ids, [root]);
  };
  for (const history of [undefined, `${String(Date.now())}\n`.repeat(3)]) {
    await rearm();
    if (history !== undefined) writeFileSync(starts, history);
    assert.deepEqual(maintain("split-at-info", root), action("ops", "unread"));
    assert.equal(existsSync(`${faultLog()}.split`), true);
    assert.equal((await panesOf()).length, 2);
    assert.equal(existsSync(starts), history !== undefined);
    if (history !== undefined) assert.equal(readFileSync(starts, "utf8"), history);
    assert.equal(existsSync(stopped), false);
    assert.equal((await workspace("ops"))?.["pane_count"], 2);
    await lab.run(["pane", "close", String((await panesOf()).find((id) => id !== root))]);
  }
  await rearm();
  const rows: unknown = JSON.parse(fleet(["status", "--json"], "split-at-info", root));
  assert.equal(records(rows)[0]?.["state"], "unknown");
  await lab.run(["pane", "close", String((await panesOf()).find((id) => id !== root))]);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [{ lane: "ops", state: "down" }]);
  rmSync(starts);
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("a split opened while Pi is being seen never lifts a hold or erases start history", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  writeFileSync(stopped, "stopped by hand\n");
  assert.deepEqual(maintain("pi-split-at-info", root), action("ops", "unread"));
  assert.equal(existsSync(`${faultLog()}.split`), true);
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
});

test("Pi leaving a pane between reads never lifts a hold or erases start history", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  writeFileSync(stopped, "stopped by hand\n");
  assert.deepEqual(maintain("pi-then-shell", root), action("ops", "unread"));
  assert.equal(existsSync(`${faultLog()}.pi`), true);
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
});

test("a utility pane changing directory does not discard valid Pi evidence in a split", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
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
  const rows: unknown = JSON.parse(fleet(["status", "--json"], "split-utility-flip", split));
  assert.equal(records(rows)[0]?.["state"], "running");
  assert.equal(existsSync(`${faultLog()}.utility`), true);
});

test("a legacy workspace whose home evidence vanishes on the confirming read is never closed", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const legacy = await idlePane("ops", home, "fleet-ops");
  const labels = async () =>
    records((await lab.run(["workspace", "list"]))["workspaces"]).map((row) => row["label"]);
  assert.throws(() => fleet(["stop", "ops"], "cwd-flip", legacy), /no root pane cwd/);
  assert.deepEqual(await labels(), ["fleet-ops"]);
  rmSync(`${faultLog()}.listed`, { force: true });
  assert.equal(fleet(["stop", "ops"]).trim(), "ops: stopped");
  assert.deepEqual(await labels(), []);
});

test("maintenance returns a completed start even when the next lane cannot be read", async () => {
  addLane("zz");
  assert.deepEqual(JSON.parse(fleet(["up", "zz", "--json"])), action("zz", "started"));
  const ws = await workspace("zz");
  assert.equal(typeof ws?.["workspace_id"], "string");
  const panes = await lab.run(["pane", "list", "--workspace", String(ws?.["workspace_id"])]);
  const pane = records(panes["panes"])[0]?.["pane_id"];
  assert.equal(typeof pane, "string");
  assert.deepEqual(maintain("later", String(pane)), [
    ...action("ops", "started"),
    ...action("zz", "unread"),
  ]);
  assert.deepEqual(maintain("server-missing", String(pane)), [
    ...action("ops", "running"),
    ...action("zz", "unread"),
  ]);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "server-missing", String(pane))), [
    { lane: "ops", state: "running" },
    { lane: "zz", state: "unknown", reason: "server not running" },
  ]);
  assert.deepEqual(maintain(), [...action("ops", "running"), ...action("zz", "running")]);
});

test("an old supervisor's command still gets array success and nonzero operation failure", async () => {
  assert.equal(fleet(["--maintenance-outcomes-v1"]).trim(), "fleet: maintenance outcomes v1");
  assert.equal(await workspace("ops"), undefined);
  assert.deepEqual(JSON.parse(fleet(legacyMaintenance)), action("ops", "started"));
  const home = addLane("zz");
  const lock = new DatabaseSync(join(home, "state", "lifecycle.db"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    let caught: unknown;
    try {
      fleet(legacyMaintenance);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.equal(Reflect.get(caught, "status"), 1);
    assert.equal(String(Reflect.get(caught, "stdout")).trim(), "");
    assert.match(String(Reflect.get(caught, "stderr")), /another fleet command.*lane zz/);
  } finally {
    lock.close();
  }
  assert.deepEqual(JSON.parse(fleet(legacyMaintenance)), [
    ...action("ops", "running"),
    ...action("zz", "started"),
  ]);
});

test("maintenance returns a completed start alongside a later lifecycle failure", async () => {
  const home = addLane("zz");
  const lock = new DatabaseSync(join(home, "state", "lifecycle.db"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    const reply = maintain();
    assert.equal(typeof reply, "object");
    assert.notEqual(reply, null);
    assert.deepEqual(Reflect.get(Object(reply), "expected"), ["ops", "zz"]);
    assert.deepEqual(Reflect.get(Object(reply), "outcomes"), action("ops", "started"));
    assert.match(String(Reflect.get(Object(reply), "failed")), /another fleet command.*lane zz/);
    assert.equal(await workspace("zz"), undefined);
  } finally {
    lock.close();
  }
  assert.deepEqual(maintain(), [...action("ops", "running"), ...action("zz", "started")]);
});

const hangingSweep = (panes: string[]) =>
  maintenanceOutcomes(fleet(typedMaintenance, "hanging-panes", panes.join(","), "60000"));

test("an early hanging observation does not starve a later healthy lane", async () => {
  const pane = await idlePane("ops", `${here.root}.worktrees/lane-ops`);
  addLane("zz");
  assert.deepEqual(hangingSweep([pane]), [...action("ops", "unread"), ...action("zz", "started")]);
  assert.equal(readFileSync(faultLog(), "utf8").trim(), pane);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [
    { lane: "ops", state: "down" },
    { lane: "zz", state: "running" },
  ]);
});

test("maintenance returns an accepted start before the caller times out on two hanging reads", async () => {
  const panes = [];
  for (const lane of ["za", "zb"]) panes.push(await idlePane(lane, addLane(lane)));
  assert.deepEqual(hangingSweep(panes), [
    ...action("ops", "started"),
    ...action("za", "unread"),
    ...action("zb", "unread"),
  ]);
  assert.deepEqual(readFileSync(faultLog(), "utf8").trim().split("\n"), panes);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [
    { lane: "ops", state: "running" },
    { lane: "za", state: "down" },
    { lane: "zb", state: "down" },
  ]);
});

test("maintenance leaves an idle pane untouched when it cannot reserve launch and readiness time", async () => {
  const panes = [];
  for (const lane of ["aa", "ab", "ac"]) panes.push(await idlePane(lane, addLane(lane)));
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  assert.deepEqual(hangingSweep(panes), [
    ...action("aa", "unread"),
    ...action("ab", "unread"),
    ...action("ac", "unread"),
    ...action("ops", "unread"),
  ]);
  assert.deepEqual(readFileSync(faultLog(), "utf8").trim().split("\n"), panes);
  assert.equal(existsSync(join(home, "state", "starts")), false);
  assert.equal(
    records(JSON.parse(fleet(["status", "--json"]))).find((row) => row["lane"] === "ops")?.[
      "state"
    ],
    "down",
  );
  assert.deepEqual(JSON.parse(fleet(["up", "ops", "--json"])), action("ops", "started"));
});

test("automatic sweeps rotate past repeated hangs and reap their probes", async () => {
  const panes = [];
  for (const lane of ["aa", "ab", "ac"]) panes.push(await idlePane(lane, addLane(lane)));
  await idlePane("ops", `${here.root}.worktrees/lane-ops`);
  writeFileSync(`${faultLog()}.targets`, `${panes.join(",")}\n`);
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  const deadline = Date.now() + 140_000;
  for (;;) {
    const rows = records(JSON.parse(fleet(["status", "--json"])));
    if (rows.find((row) => row["lane"] === "ops")?.["state"] === "running") break;
    if (Date.now() >= deadline) assert.fail("ops did not start on a later automatic sweep");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepEqual(readFileSync(faultLog(), "utf8").trim().split("\n").slice(0, 5), [
    ...panes,
    ...panes.slice(1),
  ]);
  const pids = readFileSync(`${faultLog()}.pids`, "utf8")
    .trim()
    .split("\n")
    .slice(0, 5)
    .map(Number);
  assert.equal(pids.length, 5);
  for (const pid of pids) {
    assert.ok(pid > 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("an explicit stop accepts a complete workspace close reply without a type field", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  assert.equal(fleet(["stop", "ops"], "close-without-type").trim(), "ops: stopped");
  assert.equal(await workspace("ops"), undefined);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [
    { lane: "ops", state: "stopped", reason: "stopped by hand" },
  ]);
});

test("structured pane run and silent workspace close both succeed", async () => {
  assert.deepEqual(maintain("structured-run"), action("ops", "started"));
  assert.deepEqual(maintain(), action("ops", "running"));
  assert.equal(fleet(["stop", "ops"], "silent-close").trim(), "ops: stopped");
  assert.equal(await workspace("ops"), undefined);
});

test("refused and failed pane runs are not recorded or retried", () => {
  for (const [fault, expected] of [
    ["refused-run", /no complete result/],
    ["failed-run", /exit status 1/],
  ] as const) {
    const reply = maintain(fault);
    assert.ok(isRecord(reply));
    assert.deepEqual(reply["outcomes"], []);
    assert.match(String(reply["failed"]), expected);
    assert.equal(existsSync(`${here.root}.worktrees/lane-ops/state/starts`), false);
  }
  assert.equal(readFileSync(faultLog(), "utf8"), "refused-run\nfailed-run\n");
});

test("an incomplete run acknowledgement neither records a start nor lifts a hold", () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const reply = maintain("incomplete-run");
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["outcomes"], []);
  assert.match(String(reply["failed"]), /herdr pane run.*returned no complete result/);
  assert.equal(existsSync(starts), false);
  const history = `${String(Date.now())}\n`;
  writeFileSync(starts, history);
  writeFileSync(stopped, "stopped by hand\n");
  assert.throws(() => fleet(["up", "ops", "--json"], "incomplete-run"), /no complete result/);
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
  assert.equal(readFileSync(faultLog(), "utf8"), "incomplete-run\nincomplete-run\n");
  assert.deepEqual(
    JSON.parse(fleet(["up", "ops", "--json"], "structured-run")),
    action("ops", "started"),
  );
  assert.equal(existsSync(stopped), false);
  assert.deepEqual(maintain(), action("ops", "running"));
});

test("a malformed mutation acknowledgement is an error, not a start or an unread observation", () => {
  assert.throws(
    () => fleet(["up", "--json"], "malformed"),
    /herdr pane run.*returned no complete result/,
  );
  assert.equal(existsSync(`${here.root}.worktrees/lane-ops/state/starts`), false);
});
