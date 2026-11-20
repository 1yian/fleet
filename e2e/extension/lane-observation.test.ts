import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records, type JsonRecord } from "../support/json.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let bin: string;
let real: string;

beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  cardd.addLane("main", undefined, here.root);
  addLane("ops");
  lab = await HerdrLab.start(h.piEnv("mate"));
  real = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  bin = join(here.parent, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
case "$1 $2:$HERDR_FAULT" in
  'workspace list:failed') printf '%s' '{"result":{"workspaces":[]}}'; exit 1 ;;
  'workspace list:blank') exit 0 ;;
  'workspace list:partial') printf '%s' '{"result":{"workspaces":[{"label":"2ndmate-ops"}]}}'; exit 0 ;;
  'workspace list:timeout') printf '%s' '{"result":{"workspaces":[]}}'; exec sleep 60 ;;
  'pane list:panes') printf '%s' '{"result":{}}'; exit 0 ;;
  'pane list:cwd')
    reply=$("$REAL_HERDR" "$@") || exit $?
    printf '%s' "$reply" | node -e '
      const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const pane = reply.result.panes.find((row) => row.pane_id === process.env.FAULT_PANE);
      delete pane.cwd;
      console.log(JSON.stringify(reply));
    '
    exit $? ;;
  'pane process-info:processes') printf '%s' '{"result":{"process_info":{"shell_pid":1,"foreground_process_group_id":1}}}'; exit 0 ;;
  'pane process-info:later') if [ "$4" = "$FAULT_PANE" ]; then printf '%s' '{"result"'; exit 0; fi ;;
  'pane run:malformed') printf '%s' '{}'; exit 0 ;;
esac
exec "$REAL_HERDR" "$@"
`,
    { mode: 0o755 },
  );
});

afterEach(async (t) => {
  await lab.printIfFailed(t);
  await Promise.all([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
});

function addLane(lane: string): string {
  return here.addLane(lane, {
    url: cardd.url,
    token: cardd.addLane(lane, "main"),
    args: mateArgs(h),
  });
}

function fleet(args: readonly string[], fault = "", pane = ""): string {
  return here.fleet(args, {
    ...lab.env,
    HERDR_SESSION: lab.name,
    REAL_HERDR: real,
    HERDR_FAULT: fault,
    FAULT_PANE: pane,
    FLEET_PROBE_TIMEOUT_MS: "1000",
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
  });
}

const maintain = (fault?: string, pane?: string): unknown =>
  JSON.parse(fleet(["up", "--maintenance", "--json"], fault, pane));

async function workspace(lane: string): Promise<JsonRecord | undefined> {
  return records((await lab.run(["workspace", "list"]))["workspaces"]).find(
    (row) => row["label"] === `2ndmate-${lane}`,
  );
}

const action = (lane: string, value: string) => [{ lane, action: value }];

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

test("missing nested pane or process fields neither start nor hold a lane", async () => {
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

test("only home matching needs the root pane's cwd, and no check needs a split's cwd", async () => {
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
  await lab.run(["pane", "split", root, "--direction", "right", "--no-focus"]);
  const id = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof id === "string");
  const panes = await lab.run(["pane", "list", "--workspace", id]);
  const split = records(panes["panes"]).find((pane) => pane["pane_id"] !== root)?.["pane_id"];
  assert.ok(typeof split === "string");

  await lab.run(["workspace", "rename", id, "fleet-ops"]);
  assert.deepEqual(maintain("cwd", root), action("ops", "unread"));
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "cwd", split)), [
    { lane: "ops", state: "down" },
  ]);
  await lab.run(["workspace", "rename", id, "2ndmate-ops"]);

  assert.deepEqual(maintain("cwd", root), action("ops", "started"));
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "cwd", root)), [
    { lane: "ops", state: "running" },
  ]);
  assert.deepEqual(maintain("cwd", split), action("ops", "running"));
  const placement = ["status", "--placement", "--json"];
  assert.deepEqual(JSON.parse(fleet(placement, "cwd", split)), [{ lane: "ops", mate: true }]);
  assert.throws(() => fleet(placement, "cwd", root), /no root pane cwd/);
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
  assert.deepEqual(maintain(), [...action("ops", "running"), ...action("zz", "running")]);
});

test("a malformed mutation acknowledgement is an error, not a start or an unread observation", () => {
  assert.throws(
    () => fleet(["up", "--json"], "malformed"),
    /herdr pane run.*returned no complete result/,
  );
  assert.equal(existsSync(`${here.root}.worktrees/lane-ops/state/starts`), false);
});
