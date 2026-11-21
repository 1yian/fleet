import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  workspace,
  untilRunning,
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
