import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  'workspace list:omit-once')
    if [ ! -e "$HERDR_FAULT_LOG" ]; then
      : > "$HERDR_FAULT_LOG"
      printf '%s' '{"result":{"workspaces":[]}}'
      exit 0
    fi ;;
  'pane list:panes') printf '%s' '{"result":{}}'; exit 0 ;;
  'pane list:cwd'|'pane list:split-only'|'pane list:duplicate'|'pane list:foreign')
    reply=$("$REAL_HERDR" "$@") || exit $?
    printf '%s' "$reply" | node -e '
      const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const pane = reply.result.panes.find((row) => row.pane_id === process.env.FAULT_PANE);
      switch (process.env.HERDR_FAULT) {
        case "cwd": delete pane.cwd; break;
        case "split-only": reply.result.panes = [pane]; break;
        case "duplicate": reply.result.panes = [pane, pane]; break;
        case "foreign": pane.workspace_id = "foreign"; break;
      }
      console.log(JSON.stringify(reply));
    '
    exit $? ;;
  'pane process-info:vanished')
    if [ "\${4%:*}" = "$FAULT_PANE" ]; then
      "$REAL_HERDR" workspace close "$FAULT_PANE" --session "$HERDR_SESSION" >/dev/null || exit $?
    fi ;;
  'pane process-info:processes') printf '%s' '{"result":{"process_info":{"shell_pid":1,"foreground_process_group_id":1}}}'; exit 0 ;;
  'pane process-info:later') if [ "$4" = "$FAULT_PANE" ]; then printf '%s' '{"result"'; exit 0; fi ;;
  'pane process-info:hanging-panes')
    case ",$FAULT_PANE," in
      *",$4,"*) printf '%s\\n' "$4" >> "$HERDR_FAULT_LOG"; exec sleep 120 ;;
    esac ;;
  'pane process-info:server-missing')
    if [ "$4" = "$FAULT_PANE" ]; then
      printf '%s' '{"error":{"code":"server_not_running","message":"server not running"}}'
      exit 1
    fi ;;
  'workspace close:close-without-type')
    "$REAL_HERDR" "$@" >/dev/null || exit $?
    printf '%s' '{"result":{}}'
    exit 0 ;;
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

const faultLog = () => join(bin, "observations");

function fleet(args: readonly string[], fault = "", pane = "", probeTimeout = "1000"): string {
  return execFileSync(process.execPath, [here.launch, ...args], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      ...lab.env,
      HERDR_SESSION: lab.name,
      REAL_HERDR: real,
      HERDR_FAULT: fault,
      HERDR_FAULT_LOG: faultLog(),
      FAULT_PANE: pane,
      FLEET_PROBE_TIMEOUT_MS: probeTimeout,
      FLEET_LIFECYCLE_WAIT_MS: "100",
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
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

test("a workspace omitted once neither restarts nor crash-holds a running mate", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  const home = `${here.root}.worktrees/lane-ops`;
  const startsFile = join(home, "state", "starts");
  const original = readFileSync(startsFile, "utf8");
  const repeated = `${String(Date.now())}\n`.repeat(3);
  for (const history of [original, repeated]) {
    writeFileSync(startsFile, history);
    rmSync(faultLog(), { force: true });
    assert.deepEqual(maintain("omit-once"), action("ops", "running"));
    assert.equal(readFileSync(startsFile, "utf8"), history);
    assert.equal(existsSync(join(home, "state", "stopped")), false);
  }
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
  assert.deepEqual(JSON.parse(fleet(["status", "--json"], "cwd", root)), [
    { lane: "ops", state: "running" },
  ]);
  const placement = ["status", "--placement", "--json"];
  assert.throws(() => fleet(placement, "cwd", root), /no root pane cwd/);

  const added = await lab.run(["pane", "split", root, "--direction", "right", "--no-focus"]);
  const split = records([added["pane"]])[0]?.["pane_id"];
  assert.ok(typeof split === "string");
  assert.deepEqual(maintain("cwd", split), action("ops", "running"));
  assert.deepEqual(JSON.parse(fleet(placement, "cwd", split)), [{ lane: "ops", mate: true }]);
  assert.throws(() => fleet(placement, "cwd", root), /no Pi observed/);

  const starts = join(home, "state", "starts");
  const history = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, history);
  for (const fault of ["split-only", "duplicate", "foreign"]) {
    assert.deepEqual(maintain(fault, split), action("ops", "unread"), fault);
    assert.throws(() => fleet(placement, fault, split), /incomplete pane list/);
    assert.equal(readFileSync(starts, "utf8"), history);
    assert.equal(existsSync(join(home, "state", "stopped")), false);
  }
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

test("maintenance returns a completed start alongside a later lifecycle failure", async () => {
  const home = addLane("zz");
  const lock = new DatabaseSync(join(home, "state", "lifecycle.db"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    const reply = maintain();
    assert.equal(typeof reply, "object");
    assert.notEqual(reply, null);
    assert.deepEqual(Reflect.get(Object(reply), "outcomes"), action("ops", "started"));
    assert.match(String(Reflect.get(Object(reply), "failed")), /another fleet command.*lane zz/);
    assert.equal(await workspace("zz"), undefined);
  } finally {
    lock.close();
  }
  assert.deepEqual(maintain(), [...action("ops", "running"), ...action("zz", "started")]);
});

test("maintenance returns an accepted start before the caller times out on two hanging reads", async () => {
  const panes = [];
  for (const lane of ["za", "zb"]) {
    const home = addLane(lane);
    const created = await lab.run([
      "workspace",
      "create",
      "--cwd",
      home,
      "--label",
      `2ndmate-${lane}`,
      "--no-focus",
    ]);
    const pane = records([created["root_pane"]])[0]?.["pane_id"];
    assert.ok(typeof pane === "string");
    panes.push(pane);
  }
  const out = fleet(["up", "--maintenance", "--json"], "hanging-panes", panes.join(","), "60000");
  assert.deepEqual(JSON.parse(out), [
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

test("an explicit stop accepts a complete workspace close reply without a type field", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  assert.equal(fleet(["stop", "ops"], "close-without-type").trim(), "ops: stopped");
  assert.equal(await workspace("ops"), undefined);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [
    { lane: "ops", state: "stopped", reason: "stopped by hand" },
  ]);
});

test("a malformed mutation acknowledgement is an error, not a start or an unread observation", () => {
  assert.throws(
    () => fleet(["up", "--json"], "malformed"),
    /herdr pane run.*returned no complete result/,
  );
  assert.equal(existsSync(`${here.root}.worktrees/lane-ops/state/starts`), false);
});
