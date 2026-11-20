import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { records } from "../support/json.ts";
import {
  lab,
  here,
  faultLog,
  fleet,
  maintain,
  workspace,
  action,
  idlePane,
} from "../support/lane-observation-lab.ts";

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

test("a split opened while Pi stays visible never lifts a hold or erases start history", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  writeFileSync(stopped, "stopped by hand\n");
  assert.deepEqual(maintain("pi-stays-split-at-info", root), action("ops", "unread"));
  assert.equal(existsSync(`${faultLog()}.split`), true);
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
});

test("Pi giving way to another foreground process never lifts a hold or erases start history", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  writeFileSync(stopped, "stopped by hand\n");
  assert.deepEqual(maintain("pi-then-busy", root), action("ops", "unread"));
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
});

test("a split opened during the final process sample never lifts a hold or erases start history", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  writeFileSync(stopped, "stopped by hand\n");
  assert.deepEqual(maintain("pi-stays-split-at-second-info", root), action("ops", "unread"));
  assert.equal(readFileSync(`${faultLog()}.calls`, "utf8"), "x\nx\n");
  assert.equal(records((await lab.run(["pane", "list"]))["panes"]).length, 2);
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
});

test("a pane that turns busy during checkout is never run into", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const root = await idlePane("ops", home);
  const gitHere = (...args: string[]) =>
    execFileSync("git", [
      "-C",
      here.root,
      "-c",
      "user.name=scratch",
      "-c",
      "user.email=s@example.com",
      ...args,
    ]);
  gitHere("commit", "--allow-empty", "-qm", "advance");
  const hook = join(here.root, ".git", "hooks", "post-checkout");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      ': > "$HERDR_FAULT_LOG.checkout"',
      'herdr pane run "$FAULT_PANE" "sleep 30" --session "$HERDR_SESSION" >/dev/null',
      "i=0",
      'while [ "$i" -lt 50 ]; do',
      '  herdr pane process-info --pane "$FAULT_PANE" --session "$HERDR_SESSION" | grep -q sleep && break',
      "  i=$((i+1))",
      "  sleep 0.1",
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  assert.deepEqual(maintain("", root), action("ops", "unread"));
  assert.equal(existsSync(`${faultLog()}.checkout`), true);
  assert.equal(existsSync(join(home, "state", "starts")), false);
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

test("a final pane read that drops the Pi pane's home evidence never lifts a hold or erases start history", async () => {
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
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  writeFileSync(stopped, "stopped by hand\n");
  assert.deepEqual(maintain("cwd-drop-final", split), action("ops", "unread"));
  assert.equal(readFileSync(`${faultLog()}.lists`, "utf8"), "x\nx\nx\n");
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
  rmSync(`${faultLog()}.lists`);
  assert.deepEqual(maintain("cwd-drop-final", split), action("ops", "unread"));
});
