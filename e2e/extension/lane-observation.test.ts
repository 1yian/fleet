import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, records, type JsonRecord } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

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
  configureMain(here, cardd.url, cardd.addLane("main", undefined, here.root));
  addLane("ops");
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
  'workspace list:omit-title-once')
    if [ ! -e "$HERDR_FAULT_LOG" ]; then
      : > "$HERDR_FAULT_LOG"
      reply=$("$REAL_HERDR" "$@") || exit $?
      printf '%s' "$reply" | node -e '
        const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        reply.result.workspaces = reply.result.workspaces.filter((row) => row.label !== process.env.FAULT_PANE);
        console.log(JSON.stringify(reply));
      '
      exit $?
    fi ;;
  'pane list:panes') printf '%s' '{"result":{}}'; exit 0 ;;
  'pane list:cwd'|'pane list:empty-cwd'|'pane list:split-only'|'pane list:duplicate'|'pane list:foreign')
    reply=$("$REAL_HERDR" "$@") || exit $?
    printf '%s' "$reply" | node -e '
      const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const pane = reply.result.panes.find((row) => row.pane_id === process.env.FAULT_PANE);
      switch (process.env.HERDR_FAULT) {
        case "cwd": delete pane.cwd; break;
        case "empty-cwd": pane.cwd = ""; break;
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
  'pane process-info:pi-in-split')
    if [ "$4" = "$FAULT_PANE" ]; then
      printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
      exit 0
    fi ;;
  'pane process-info:empty-busy')
    if [ "$4" = "$FAULT_PANE" ]; then
      printf '%s' '{"result":{"process_info":{"shell_pid":1,"foreground_process_group_id":2,"foreground_processes":[]}}}'
      exit 0
    fi ;;
  'pane process-info:processes') printf '%s' '{"result":{"process_info":{"shell_pid":1,"foreground_process_group_id":1}}}'; exit 0 ;;
  'pane process-info:later') if [ "$4" = "$FAULT_PANE" ]; then printf '%s' '{"result"'; exit 0; fi ;;
  'pane process-info:hanging-panes')
    if [ -f "$HERDR_FAULT_LOG.targets" ]; then IFS= read -r FAULT_PANE < "$HERDR_FAULT_LOG.targets"; fi
    case ",$FAULT_PANE," in
      *",$4,"*)
        trap '' TERM
        printf '%s\\n' "$4" >> "$HERDR_FAULT_LOG"
        printf '%s\\n' "$$" >> "$HERDR_FAULT_LOG.pids"
        exec sleep 180 ;;
    esac ;;
  'pane process-info:server-missing')
    if [ "$4" = "$FAULT_PANE" ]; then
      printf '%s' '{"error":{"code":"server_not_running","message":"server not running"}}'
      exit 1
    fi ;;
  'workspace close:silent-close')
    exec "$REAL_HERDR" "$@" >/dev/null ;;
  'pane run:structured-run')
    "$REAL_HERDR" "$@" >/dev/null || exit $?
    printf '%s' '{"result":{"type":"ok"}}'
    exit 0 ;;
  'pane run:refused-run'|'pane run:failed-run')
    printf '%s\\n' "$HERDR_FAULT" >> "$HERDR_FAULT_LOG"
    if [ "$HERDR_FAULT" = 'refused-run' ]; then
      printf '%s' '{"error":{"code":"refused","message":"run refused"}}'
      exit 0
    fi
    printf '%s' '{"result":{"type":"ok"}}'
    exit 1 ;;
  'workspace close:close-without-type')
    "$REAL_HERDR" "$@" >/dev/null || exit $?
    printf '%s' '{"result":{}}'
    exit 0 ;;
  'pane run:incomplete-run')
    printf '%s\\n' "$HERDR_FAULT" >> "$HERDR_FAULT_LOG"
    printf '%s' '{"result":{}}'
    exit 0 ;;
  'pane run:malformed') printf '%s' '{}'; exit 0 ;;
esac
exec "$REAL_HERDR" "$@"
`,
    { mode: 0o755 },
  );
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    REAL_HERDR: real,
    HERDR_FAULT: "hanging-panes",
    HERDR_FAULT_LOG: faultLog(),
    FLEET_SUPERVISE_MS: "1000",
  });
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

const legacyMaintenance = ["up", "--maintenance", "--json"];
const typedMaintenance = [...legacyMaintenance, "--maintenance-outcomes-v1", "0"];
function maintenanceOutcomes(out: string): unknown {
  const reply: unknown = JSON.parse(out);
  assert.ok(isRecord(reply));
  assert.ok(Array.isArray(reply["expected"]));
  assert.ok(Array.isArray(reply["outcomes"]));
  if (reply["failed"] !== undefined) return reply;
  assert.deepEqual(
    reply["expected"],
    records(reply["outcomes"]).map((row) => row["lane"]),
  );
  return reply["outcomes"];
}

const maintain = (fault?: string, pane?: string): unknown =>
  maintenanceOutcomes(fleet(typedMaintenance, fault, pane));

async function workspace(lane: string): Promise<JsonRecord | undefined> {
  return records((await lab.run(["workspace", "list"]))["workspaces"]).find(
    (row) => row["label"] === `2ndmate-${lane}`,
  );
}

const action = (lane: string, value: string) => [{ lane, action: value }];

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
    return fleet(args, "omit-once");
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

test("an unreadable lane config is reported safely while healthy lanes still converge and start", async () => {
  addLane("zz");
  const ops = `${here.root}.worktrees/lane-ops`;
  const sentinel = "ZSENTINELTOKENZ";
  writeFileSync(
    `${here.root}.worktrees/lane-zz/config/lane.json`,
    `{"lane":"zz","token": ${sentinel}}`,
  );
  writeFileSync(join(ops, "data", "captain-shared.md"), "local edit\n");
  const content = Buffer.from("- shared\n").toString("base64");
  assert.throws(
    () => fleet(["shared", "--content", content]),
    (error: unknown) => {
      const stdout = String(Reflect.get(Object(error), "stdout"));
      const stderr = String(Reflect.get(Object(error), "stderr"));
      assert.match(stdout, /ops: shared preferences updated, edited copy preserved as data\//);
      assert.match(stderr, /lane zz could not be read: \S+lane\.json is not valid JSON/);
      assert.match(stderr, /ops: shared preferences updated, edited copy preserved as data\//);
      assert.ok(!stdout.includes(sentinel) && !stderr.includes(sentinel));
      return true;
    },
  );
  assert.equal(readFileSync(join(ops, "data", "captain-shared.md"), "utf8"), "- shared\n");
  const reply = maintain();
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops", "zz"]);
  assert.deepEqual(reply["outcomes"], action("ops", "started"));
  assert.match(
    String(reply["failed"]),
    /^lane zz could not be read: \S+lane\.json is not valid JSON$/,
  );
  const status = records(JSON.parse(fleet(["status", "--json"])));
  assert.deepEqual(status[0], { lane: "ops", state: "running" });
  assert.equal(status[1]?.["state"], "unknown");
  assert.match(String(status[1]?.["reason"]), /lane\.json is not valid JSON$/);
  assert.ok(!JSON.stringify(status).includes(sentinel));
  assert.throws(() => fleet(["status", "--placement", "--json"]), /lane zz could not be read/);
  const before = (await workspace("ops"))?.["workspace_id"];
  assert.throws(() => fleet(["restart"]), /lane zz could not be read/);
  assert.equal((await workspace("ops"))?.["workspace_id"], before);
});

test("an unreadable stop marker or start history is unknown and never authorizes a start", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  const stopped = join(home, "state", "stopped");
  const starts = join(home, "state", "starts");
  mkdirSync(stopped);
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(existsSync(starts), false);
  const status = records(JSON.parse(fleet(["status", "--json"])));
  assert.equal(status[0]?.["state"], "unknown");
  assert.match(String(status[0]?.["reason"]), /could not read state\/stopped \(EISDIR\)/);
  rmSync(stopped, { recursive: true });
  mkdirSync(starts);
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(existsSync(stopped), false);
  rmSync(starts, { recursive: true });
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("a later preference write failure does not hide an earlier confirmed aside", async () => {
  addLane("zz");
  const ops = `${here.root}.worktrees/lane-ops`;
  const zz = `${here.root}.worktrees/lane-zz`;
  writeFileSync(join(ops, "data", "captain-shared.md"), "local edit\n");
  rmSync(join(zz, "data"), { recursive: true });
  writeFileSync(join(zz, "data"), "");
  const content = Buffer.from("- shared\n").toString("base64");
  assert.throws(
    () => fleet(["shared", "--content", content]),
    (error: unknown) => {
      const stderr = String(Reflect.get(Object(error), "stderr"));
      assert.match(stderr, /lane zz could not be updated/);
      assert.match(
        stderr,
        /^fleet-preserved: ops: shared preferences updated, edited copy preserved as data\//m,
      );
      return true;
    },
  );
  assert.equal(readFileSync(join(ops, "data", "captain-shared.md"), "utf8"), "- shared\n");
});

test("a hold with unread start history neither starts, closes, nor lifts anything", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  const before = (await workspace("ops"))?.["workspace_id"];
  const stopped = join(home, "state", "stopped");
  writeFileSync(stopped, "held by operator\n");
  mkdirSync(join(home, "state", "starts"));
  for (const args of [["up", "ops", "--json"], ["restart", "ops"], ["restart"], ["stop", "ops"]]) {
    assert.throws(() => fleet(args), /could not read state\/starts \(EISDIR\)/);
    assert.equal(readFileSync(stopped, "utf8"), "held by operator\n", args.join(" "));
    assert.equal((await workspace("ops"))?.["workspace_id"], before, args.join(" "));
  }
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(readFileSync(stopped, "utf8"), "held by operator\n");
});

test("a torn start history is unread and never authorizes another launch", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const now = String(Date.now());
  const torn = `${now}\n${now}\n${now.slice(0, 7)}`;
  writeFileSync(starts, torn);
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(readFileSync(starts, "utf8"), torn);
  assert.equal(existsSync(join(home, "state", "stopped")), false);
  assert.throws(() => fleet(["stop", "ops"]), /state\/starts is incomplete/);
  writeFileSync(starts, `${now}\n${now}\n${now}\n`);
  assert.deepEqual(maintain(), [
    { lane: "ops", action: "held", detail: "started 3 times in 10 minutes" },
  ]);
});

test("an empty foreground list with a foreign group never lifts a hold or erases history", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const pane = await idlePane("ops", home);
  const stopped = join(home, "state", "stopped");
  const starts = join(home, "state", "starts");
  const history = `${String(Date.now())}\n`;
  writeFileSync(stopped, "held by operator\n");
  writeFileSync(starts, history);
  assert.deepEqual(maintain("empty-busy", pane), action("ops", "unread"));
  assert.equal(readFileSync(stopped, "utf8"), "held by operator\n");
  assert.equal(readFileSync(starts, "utf8"), history);
  const status = records(JSON.parse(fleet(["status", "--json"], "empty-busy", pane)));
  assert.equal(status[0]?.["state"], "unknown");
});

test("a failure after the aside is written still reports where the edited copy was kept", async () => {
  const ops = `${here.root}.worktrees/lane-ops`;
  writeFileSync(join(ops, "data", "captain-shared.md"), "local edit\n");
  const content = Buffer.from("- shared\n").toString("base64");
  chmodSync(join(ops, "state"), 0o555);
  try {
    assert.throws(
      () => fleet(["shared", "--content", content]),
      (error: unknown) => {
        const stderr = String(Reflect.get(Object(error), "stderr"));
        assert.match(stderr, /lane ops could not be updated/);
        assert.match(
          stderr,
          /^fleet-preserved: ops: shared preferences incomplete, edited copy preserved as data\/captain-shared\.edited-/m,
        );
        return true;
      },
    );
  } finally {
    chmodSync(join(ops, "state"), 0o755);
  }
  assert.ok(
    readdirSync(join(ops, "data")).some((name) => name.startsWith("captain-shared.edited-")),
  );
});

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
    return fleet(args, "omit-title-once", title);
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

async function idlePane(lane: string, home: string, title = `2ndmate-${lane}`): Promise<string> {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    home,
    "--label",
    title,
    "--no-focus",
  ]);
  const pane = records([created["root_pane"]])[0]?.["pane_id"];
  assert.ok(typeof pane === "string");
  return pane;
}

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

test("an incomplete run acknowledgement neither records a start nor lifts a hold", async () => {
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
