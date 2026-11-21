import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { records } from "../support/json.ts";
import {
  addLane,
  action,
  faultLog,
  fleet,
  here,
  idlePane,
  maintain,
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
  assert.match(String(earlier?.["reason"]), /ops workspace changed while it was being read/);
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
