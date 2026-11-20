import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { Cardd } from "./cardd.ts";
import { Harness } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { isRecord, records, type JsonRecord } from "./json.ts";
import { configureMain, mateArgs, Scratch } from "./scratch.ts";

const HERDR_SHIM = `#!/bin/sh
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
  'workspace list:omit-title-once'|'workspace list:omit-id-once')
    if [ ! -e "$HERDR_FAULT_LOG" ]; then
      : > "$HERDR_FAULT_LOG"
      reply=$("$REAL_HERDR" "$@") || exit $?
      printf '%s' "$reply" | node -e '
        const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        const field = process.env.HERDR_FAULT === "omit-id-once" ? "workspace_id" : "label";
        reply.result.workspaces = reply.result.workspaces.filter((row) => row[field] !== process.env.FAULT_PANE);
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
  'pane process-info:pi-then-busy')
    if [ "$4" = "$FAULT_PANE" ] && [ ! -e "$HERDR_FAULT_LOG.pi" ]; then
      : > "$HERDR_FAULT_LOG.pi"
      printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
      exit 0
    fi
    if [ "$4" = "$FAULT_PANE" ]; then
      printf '%s' '{"result":{"process_info":{"shell_pid":1,"foreground_process_group_id":2,"foreground_processes":[{"pid":2,"name":"sleep","argv":["sleep","60"]}]}}}'
      exit 0
    fi ;;
  'pane process-info:pi-stays-split-at-second-info')
    if [ "$4" = "$FAULT_PANE" ]; then
      printf 'x\\n' >> "$HERDR_FAULT_LOG.calls"
      if [ "$(wc -l < "$HERDR_FAULT_LOG.calls")" -eq 2 ]; then
        "$REAL_HERDR" pane split "$4" --direction right --no-focus --session "$HERDR_SESSION" >/dev/null || exit $?
      fi
      printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
      exit 0
    fi ;;
  'pane process-info:pi-stays-split-at-info')
    if [ "$4" = "$FAULT_PANE" ]; then
      if [ ! -e "$HERDR_FAULT_LOG.split" ]; then
        : > "$HERDR_FAULT_LOG.split"
        "$REAL_HERDR" pane split "$4" --direction right --no-focus --session "$HERDR_SESSION" >/dev/null || exit $?
      fi
      printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
      exit 0
    fi ;;
  'pane process-info:split-at-info'|'pane process-info:pi-split-at-info')
    if [ "$4" = "$FAULT_PANE" ] && [ ! -e "$HERDR_FAULT_LOG.split" ]; then
      : > "$HERDR_FAULT_LOG.split"
      "$REAL_HERDR" pane split "$4" --direction right --no-focus --session "$HERDR_SESSION" >/dev/null || exit $?
      if [ "$HERDR_FAULT" = 'pi-split-at-info' ]; then
        printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
        exit 0
      fi
    fi ;;
  'pane process-info:pi-then-shell')
    if [ "$4" = "$FAULT_PANE" ] && [ ! -e "$HERDR_FAULT_LOG.pi" ]; then
      : > "$HERDR_FAULT_LOG.pi"
      printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
      exit 0
    fi ;;
  'pane process-info:split-utility-flip')
    if [ "$4" = "$FAULT_PANE" ]; then
      printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
      exit 0
    fi ;;
  'pane process-info:cwd-drop-final')
    if [ "$4" = "$FAULT_PANE" ]; then
      printf '%s' '{"result":{"process_info":{"foreground_processes":[{"pid":1,"name":"pi","argv":["pi"]}]}}}'
      exit 0
    fi ;;
  'pane list:cwd-drop-final')
    reply=$("$REAL_HERDR" "$@") || exit $?
    printf 'x\\n' >> "$HERDR_FAULT_LOG.lists"
    if [ "$(wc -l < "$HERDR_FAULT_LOG.lists")" -lt 3 ]; then
      printf '%s' "$reply"
      exit 0
    fi
    printf '%s' "$reply" | node -e '
      const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      for (const row of reply.result.panes) if (row.pane_id === process.env.FAULT_PANE) delete row.cwd;
      console.log(JSON.stringify(reply));
    '
    exit $? ;;
  'pane list:split-utility-flip')
    reply=$("$REAL_HERDR" "$@") || exit $?
    if [ ! -e "$HERDR_FAULT_LOG.utility" ]; then
      : > "$HERDR_FAULT_LOG.utility"
      printf '%s' "$reply"
      exit 0
    fi
    printf '%s' "$reply" | node -e '
      const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      for (const row of reply.result.panes) if (row.pane_id !== process.env.FAULT_PANE) row.cwd = "/tmp";
      console.log(JSON.stringify(reply));
    '
    exit $? ;;
  'pane list:cwd-flip')
    reply=$("$REAL_HERDR" "$@") || exit $?
    if [ ! -e "$HERDR_FAULT_LOG.listed" ]; then
      : > "$HERDR_FAULT_LOG.listed"
      printf '%s' "$reply"
      exit 0
    fi
    printf '%s' "$reply" | node -e '
      const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      for (const row of reply.result.panes) if (row.pane_id === process.env.FAULT_PANE) delete row.cwd;
      console.log(JSON.stringify(reply));
    '
    exit $? ;;
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
  'pane process-info:gated-ready')
    if [ "$4" = "$FAULT_PANE" ] && [ -e "$HERDR_FAULT_LOG.gate" ]; then
      if [ -e "$HERDR_FAULT_LOG.ran" ]; then : > "$HERDR_FAULT_LOG.polled"; fi
      printf '%s' '{"result":{"process_info":{"shell_pid":1,"foreground_process_group_id":1,"foreground_processes":[]}}}'
      exit 0
    fi ;;
  'pane run:gated-ready')
    "$REAL_HERDR" "$@"
    code=$?
    if [ "$code" -eq 0 ]; then : > "$HERDR_FAULT_LOG.ran"; fi
    exit $code ;;
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
`;

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
  writeFileSync(join(bin, "herdr"), HERDR_SHIM, { mode: 0o755 });
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

export {
  h,
  lab,
  here,
  bin,
  real,
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
};
