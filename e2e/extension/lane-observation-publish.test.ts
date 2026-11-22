import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRecord, records } from "../support/json.ts";
import {
  addLane,
  action,
  faultLog,
  fleet,
  here,
  idlePane,
  lab,
  maintain,
  typedMaintenance,
  workspace,
  untilRunning,
  useSteadyPi,
} from "../support/lane-observation-lab.ts";

const ops = (): string => `${here.root}.worktrees/lane-ops`;

const splitOps = (root: string): string =>
  `"$REAL_HERDR" pane split ${root} --direction right --no-focus --session "$HERDR_SESSION"`;

test("placement refuses a live mate whose captured start history is stably malformed", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  await untilRunning("ops");
  writeFileSync(join(ops(), "state", "starts"), "");
  assert.throws(() => fleet(["status", "--placement", "--json"]), /state\/starts is incomplete/);
  const rows = records(JSON.parse(fleet(["status", "--json"])));
  assert.equal(rows[0]?.["state"], "unknown");
});

test("status reports an earlier lane unknown when its workspace is split while a later lane is read", async () => {
  const root = await idlePane("ops", ops());
  addLane("zz");
  const rows = records(JSON.parse(fleet(["status", "--json"], "run-later", splitOps(root))));
  assert.ok(existsSync(`${faultLog()}.ran`));
  const earlier = rows.find((row) => row["lane"] === "ops");
  assert.equal(earlier?.["state"], "unknown");
  assert.match(String(earlier["reason"]), /ops workspace changed while it was being read/);
  assert.equal(rows.find((row) => row["lane"] === "zz")?.["state"], "down");
});

test("placement refuses an earlier lane whose workspace is split while a later lane is read", async () => {
  const root = await idlePane("ops", ops());
  addLane("zz");
  assert.throws(
    () => fleet(["status", "--placement", "--json"], "run-later", splitOps(root)),
    /ops workspace changed while it was being read/,
  );
  assert.ok(existsSync(`${faultLog()}.ran`));
});

const replaceClaim = (): string => {
  const config = join(ops(), "config", "lane.json");
  const raw: unknown = JSON.parse(readFileSync(config, "utf8"));
  assert.ok(isRecord(raw));
  writeFileSync(`${config}.next`, JSON.stringify({ ...raw, args: ["--changed-in-final-listing"] }));
  return config;
};

test("status never publishes a lane whose claim is replaced during the final workspace listing", () => {
  const config = replaceClaim();
  const rows = records(JSON.parse(fleet(["status", "--json"], "swap-final", config)));
  assert.ok(existsSync(`${config}.swapped`));
  assert.equal(rows[0]?.["state"], "unknown");
  assert.match(String(rows[0]["reason"]), /ops claim changed or became ambiguous/);
});

test("placement refuses a lane whose claim is replaced during the final workspace listing", () => {
  const config = replaceClaim();
  assert.throws(
    () => fleet(["status", "--placement", "--json"], "swap-final", config),
    /ops claim changed or became ambiguous/,
  );
  assert.ok(existsSync(`${config}.swapped`));
});

test("a workspace renamed during the confirming pane read is neither stopped nor marked", async () => {
  const root = await idlePane("ops", ops());
  const before = await workspace("ops");
  assert.ok(typeof before?.["workspace_id"] === "string");
  assert.throws(
    () => fleet(["stop", "ops"], "rename-final", root),
    /herdr workspace candidates changed for ops/,
  );
  assert.equal(existsSync(join(ops(), "state", "stopped")), false);
  const after = records((await lab.run(["workspace", "list"]))["workspaces"]);
  assert.equal(
    after.find((row) => row["workspace_id"] === before["workspace_id"])?.["label"],
    "fleet-utility",
  );
});

test("a pane replaced between the two close reads, with the count unchanged, is neither stopped nor marked", async () => {
  const root = await idlePane("ops", ops());
  const before = await workspace("ops");
  assert.ok(typeof before?.["workspace_id"] === "string");
  assert.throws(
    () => fleet(["stop", "ops"], "replace-between", root),
    /herdr workspace candidates changed for ops/,
  );
  assert.equal(existsSync(join(ops(), "state", "stopped")), false);
  assert.equal((await workspace("ops"))?.["workspace_id"], before["workspace_id"]);
});

test("a non-Pi foreground child in the shell's own process group leaves the lane unread and authorizes no launch or crash hold", async () => {
  const root = await idlePane("ops", ops());
  assert.deepEqual(maintain("shared-group-child", root), action("ops", "unread"));
  assert.equal(existsSync(join(ops(), "state", "starts")), false);
  assert.equal(existsSync(join(ops(), "state", "stopped")), false);
});

test("a same-group foreground child never clears a hold or lets restart-all replace the workspace", async () => {
  const root = await idlePane("ops", ops());
  const stopped = join(ops(), "state", "stopped");
  const starts = join(ops(), "state", "starts");
  const history = `${String(Date.now())}\n`;
  writeFileSync(stopped, "stopped by hand\n");
  writeFileSync(starts, history);
  const before = await workspace("ops");
  assert.ok(typeof before?.["workspace_id"] === "string");
  assert.deepEqual(maintain("shared-group-child", root), action("ops", "unread"));
  assert.throws(() => fleet(["restart"], "shared-group-child", root));
  assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
  assert.equal(readFileSync(starts, "utf8"), history);
  assert.equal((await workspace("ops"))?.["workspace_id"], before["workspace_id"]);
});

test("a readable Pi beside a Git child missing argv leaves the lane unknown", async () => {
  const root = await idlePane("ops", ops());
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "partial-git-child", root)), [
    {
      lane: "ops",
      state: "unknown",
      reason: `herdr returned an incomplete process list for pane ${root}`,
    },
  ]);
  assert.deepEqual(maintain("partial-git-child", root), action("ops", "unread"));
});

const heldWithReply = (name: string, fault: string): void => {
  test(name, async () => {
    const root = await idlePane("ops", ops());
    const stopped = join(ops(), "state", "stopped");
    const starts = join(ops(), "state", "starts");
    const history = `${String(Date.now())}\n`;
    writeFileSync(stopped, "stopped by hand\n");
    writeFileSync(starts, history);
    const before = await workspace("ops");
    assert.ok(typeof before?.["workspace_id"] === "string");
    assert.deepEqual(maintain(fault, root), action("ops", "unread"));
    assert.throws(() => fleet(["restart"], fault, root));
    assert.equal(readFileSync(stopped, "utf8"), "stopped by hand\n");
    assert.equal(readFileSync(starts, "utf8"), history);
    assert.equal((await workspace("ops"))?.["workspace_id"], before["workspace_id"]);
  });
};

heldWithReply(
  "a Pi-only partial process reply on a held lane clears no hold and lets restart-all replace nothing",
  "pi-only",
);
heldWithReply(
  "a lone Pi row in the shell's own group on a held lane clears no hold and lets restart-all replace nothing",
  "pi-alone-same-group",
);
heldWithReply(
  "a Pi row beside another child in the shell's own group on a held lane clears no hold and lets restart-all replace nothing",
  "pi-and-child-same-group",
);

test("a lane config published while an existing lane is read keeps the sweep's coverage incomplete", () => {
  const worktrees = `${here.root}.worktrees`;
  const make = `mkdir -p ${worktrees}/lane-yy/config && printf '{' > ${worktrees}/lane-yy/config/lane.json`;
  const reply: unknown = JSON.parse(fleet(typedMaintenance, "run-later", make));
  assert.ok(existsSync(`${faultLog()}.ran`));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops"]);
  assert.deepEqual(reply["outcomes"], action("ops", "started"));
  assert.match(String(reply["failed"]), /lane yy could not be read: .*not valid JSON/);
});

test("a confirmed start whose claim is removed before the sweep ends blocks recovery", () => {
  const config = join(ops(), "config", "lane.json");
  const reply: unknown = JSON.parse(fleet(typedMaintenance, "after-run", `rm ${config}`));
  assert.ok(!existsSync(config));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops"]);
  assert.deepEqual(reply["outcomes"], action("ops", "started"));
  assert.match(String(reply["failed"]), /lane ops could not be read: .*claim changed/);
});

test("a confirmed start followed by a failed final discovery blocks recovery", () => {
  const worktrees = `${here.root}.worktrees`;
  try {
    const reply: unknown = JSON.parse(
      fleet(typedMaintenance, "after-run", `chmod 300 ${worktrees}`),
    );
    chmodSync(worktrees, 0o700);
    assert.ok(isRecord(reply));
    assert.deepEqual(reply["expected"], ["ops"]);
    assert.deepEqual(reply["outcomes"], action("ops", "started"));
    assert.match(String(reply["failed"]), /could not be read again/);
  } finally {
    chmodSync(worktrees, 0o700);
  }
});

test("a confirmed lane whose workspace closes while a later lane is read blocks recovery but keeps both outcomes", async () => {
  useSteadyPi();
  assert.deepEqual(maintain(), action("ops", "started"));
  await untilRunning("ops");
  const id = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof id === "string");
  addLane("zz");
  const close = `"$REAL_HERDR" workspace close ${id} --session "$HERDR_SESSION"`;
  const reply: unknown = JSON.parse(fleet(typedMaintenance, "run-later", close));
  assert.ok(existsSync(`${faultLog()}.ran`));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops", "zz"]);
  assert.deepEqual(reply["outcomes"], [
    { lane: "ops", action: "running" },
    { lane: "zz", action: "started" },
  ]);
  assert.match(String(reply["failed"]), /lane ops could not be read: ops workspace changed/);
});
