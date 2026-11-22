import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { currentDependencies } from "../support/fork-fixture.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { optionalString, parseRecord, records } from "../support/json.ts";
import { addRemote, git, landOnRemote, tip } from "../support/remote.ts";
import { ownWorkspacePackages } from "../support/protocol-skew.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/recording-transport.ts", import.meta.url));
const UPSTREAM = "no-mistakes version v1.106.1 (abcdef12) 2026-11-17T00:00:00Z";
const LANES = ["1stmate", "2ndmate-ops", "2ndmate-far", "2ndmate-vmlane"] as const;

interface Fleet {
  cardd: Cardd;
  h: Harness;
  lab: HerdrLab;
  here: Scratch;
  p620: Scratch;
  vm: Scratch;
  app: Scratch;
  selectedClone: Scratch;
  excludedClone: Scratch;
  remote: string;
  ghost: Session;
  farHome: string;
  p620Log: string;
  vmLog: string;
  upstream: string;
  pane: string;
  before: Record<string, number>;
}

let fleet: Fleet | undefined;

afterEach(async (t) => {
  if (fleet === undefined) return;
  const { lab, ghost, h, cardd, here, p620, vm, app, selectedClone, excludedClone } = fleet;
  fleet = undefined;
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([ghost.close(), lab.stop(), h.stop(), cardd.stop()]);
  for (const scratch of [here, p620, vm, app, selectedClone, excludedClone]) scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function cloneOf(remote: string, name: string): Scratch {
  const scratch = new Scratch(name);
  git(scratch.root, "remote", "add", "origin", remote);
  git(scratch.root, "fetch", "-q", "origin");
  git(scratch.root, "reset", "-q", "--hard", "origin/main");
  return scratch;
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const callsTo = (log: string): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);

async function piOf(lab: HerdrLab, label: string): Promise<number | undefined> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === label);
  if (workspace === undefined) return undefined;
  const listed = await lab.run(["pane", "list", "--workspace", String(workspace["workspace_id"])]);
  const pane = records(listed["panes"])[0] === undefined ? undefined : records(listed["panes"])[0];
  const id = pane === undefined ? undefined : optionalString(pane, "pane_id");
  if (id === undefined) return undefined;
  const info = records([(await lab.run(["pane", "process-info", "--pane", id]))["process_info"]]);
  const pi = records(info[0]?.["foreground_processes"]).find(
    (each) => each["name"] === "pi" || each["argv0"] === "pi",
  );
  return pi === undefined ? undefined : Number(pi["pid"]);
}

async function running(lab: HerdrLab): Promise<Record<string, number>> {
  return until(async () => {
    const pids = await Promise.all(LANES.map((label) => piOf(lab, label)));
    return pids.every((pid) => pid !== undefined)
      ? Object.fromEntries(LANES.map((label, index) => [label, pids[index] ?? 0]))
      : undefined;
  }, "main and every mate to run Pi");
}

async function start(options: { cardd?: boolean; olderCardd?: boolean } = {}): Promise<Fleet> {
  const h = await Harness.start();
  const here = new Scratch();
  const remote = addRemote(here.root);
  const p620 = cloneOf(remote, "fleet");
  const vm = cloneOf(remote, "fleet");
  const app = cloneOf(remote, "app");
  const selectedClone = cloneOf(remote, "selected-project");
  const excludedClone = cloneOf(remote, "excluded-project");
  if (options.olderCardd === true) {
    ownWorkspacePackages(app.root);
    const file = join(app.root, "packages", "protocol", "src", "maintenance.ts");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"maintenance.scoped": {', '"maintenance.older": {'),
    );
    git(app.root, "commit", "-qam", "an older cardd without scoped reloads");
    const olderRemote = join(app.parent, "app-older.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", olderRemote]);
    git(app.root, "remote", "set-url", "origin", olderRemote);
    git(app.root, "push", "-q", "-u", "origin", "main");
  }
  const cardd = await Cardd.underKeepAlive(app.root);
  const p620Log = join(here.parent, "p620-calls");
  const vmLog = join(here.parent, "vm-calls");
  writeFileSync(p620Log, "");
  writeFileSync(vmLog, "");
  const stub = join(h.dir, "nm-upstream");
  mkdirSync(stub);
  writeFileSync(join(stub, "no-mistakes"), `#!/bin/sh\necho '${UPSTREAM}'\n`, { mode: 0o755 });
  const upstream = join(here.parent, "vm-upstream-only");
  configureMain(here, cardd.url, cardd.addLane("main", undefined, here.root), {
    hosts: {
      p620: ["node", TRANSPORT, p620Log, stub, join(here.parent, "never")],
      vm: ["node", TRANSPORT, vmLog, stub, upstream],
    },
    roots: { p620: p620.root, vm: vm.root },
    ...(options.cardd === false
      ? {}
      : { cardd: { root: app.root, db: cardd.db, restart: cardd.restartCommand } }),
  });
  const settings = (lane: string, host?: string) => ({
    url: cardd.url,
    token: cardd.addLane(lane, "main"),
    args: mateArgs(h),
    ...(host === undefined ? {} : { host }),
  });
  here.addLane("ops", settings("ops"));
  const farHome = p620.addLane("far", settings("far", "p620"));
  vm.addLane("vmlane", settings("vmlane", "vm"));
  cardd.addProject("a-excluded", { vm: excludedClone.root });
  cardd.addProject("b-selected", { p620: selectedClone.root });
  const ghost = await cardd.connect(cardd.addLane("ghost", "main"));
  const lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "3600000",
    FLEET_CARDD_WAIT_MS: "15000",
    FLEET_MAINTENANCE_WAIT_MS: "20000",
  });
  const started = {
    cardd,
    h,
    lab,
    here,
    p620,
    vm,
    app,
    selectedClone,
    excludedClone,
    remote,
    ghost,
    farHome,
    p620Log,
    vmLog,
    upstream,
    pane: "",
    before: {},
  };
  fleet = started;
  started.pane = await startMain(lab, here, h);
  started.before = await running(lab);
  await until(
    () =>
      callsTo(vmLog).some((call) => call.includes("'cost'")) &&
      [p620Log, vmLog].every((log) => callsTo(log).some((call) => call.includes("refresh_clone")))
        ? true
        : undefined,
    "main's first supervision pass and clone refresh to finish on every host",
  );
  writeFileSync(upstream, "");
  return started;
}

async function wakeMain(f: Fleet, title: string): Promise<void> {
  const card: unknown = await f.ghost.call("card.new", { title, kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await f.ghost.call("hold", { card: id, question: `${title}?`, options: ["Yes"] });
}

async function toolRun(f: Fleet, args: { hosts?: string[] }): Promise<string> {
  const first = f.h.callsOf("mate").length;
  f.h.onModel(() => ({ tool: "update_fleet", args }), "mate");
  let result = "";
  f.h.onModel((turns) => {
    result = toolResults(turns).at(-1) ?? "";
    return { text: "the update answered" };
  }, "mate");
  await wakeMain(f, "Update the fleet");
  await f.h.waitForCall(first + 1, "mate", WAIT_MS);
  return result;
}

const users = (turns: Turn[]): string =>
  turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("\n");

const enrolled = (db: string): string[] => {
  const open = new DatabaseSync(db, { readOnly: true, timeout: 5000 });
  try {
    return open
      .prepare(
        "SELECT s.lane AS lane FROM maintenance m JOIN sessions s ON s.id = m.session ORDER BY s.lane",
      )
      .all()
      .map((row) => String(row["lane"]));
  } finally {
    open.close();
  }
};

const updateMessages = (f: Fleet): string[] =>
  readdirSync(join(f.h.dir, "sessions")).flatMap((file) =>
    readFileSync(join(f.h.dir, "sessions", file), "utf8")
      .split("\n")
      .filter((line) => line.includes('"customType":"fleet-update"'))
      .map((line) => String(Reflect.get(parseRecord(line), "content"))),
  );

const scratchCalls = (log: string): number =>
  callsTo(log).filter((call) => call.includes("'scratch'")).length;

const tips = (f: Fleet): string[] => [f.here.root, f.p620.root, f.vm.root].map((root) => tip(root));

test("/updatefleet with a host list updates only those hosts: the excluded host gets no call and no reload enrollment, and the report says so", async () => {
  const f = await start();
  const old = tip(f.here.root);
  const excluded = callsTo(f.vmLog).length;
  const fresh = landOnRemote(f.remote, "fleet-fix");
  const supervised = scratchCalls(f.p620Log);

  await f.lab.submit(f.pane, "/updatefleet local p620");
  const after = await until(async () => {
    const now = await running(f.lab);
    return now["1stmate"] !== f.before["1stmate"] &&
      now["2ndmate-ops"] !== f.before["2ndmate-ops"] &&
      now["2ndmate-far"] !== f.before["2ndmate-far"]
      ? now
      : undefined;
  }, "main, ops, and far to run a new Pi");

  await until(
    () =>
      scratchCalls(f.p620Log) > supervised && tip(f.selectedClone.root) === fresh
        ? true
        : undefined,
    "the relaunched main's first supervision pass and clone refresh to finish on p620",
  );
  assert.equal(after["2ndmate-vmlane"], f.before["2ndmate-vmlane"]);
  assert.deepEqual(tips(f), [fresh, fresh, old]);
  assert.deepEqual(enrolled(f.cardd.db), ["far", "ops"]);

  f.h.onModel(() => ({ text: "noted" }), "mate");
  const calls = f.h.callsOf("mate").length;
  await wakeMain(f, "Check the update");
  const said = users(await f.h.waitForCall(calls, "mate", WAIT_MS));
  const range = `${old.slice(0, 7)}..${fresh.slice(0, 7)} (1 commit)`;
  const from = said.indexOf("[fleet] update:");
  const report = said.slice(from, said.indexOf("\n", said.indexOf("Main: restarts", from)));
  assert.deepEqual(report.split("\n"), [
    "[fleet] update: Fleet updated.",
    "Hosts:",
    `- local (${realpathSync(f.here.root)}): updated ${range}; board built; lane homes moved: ops; ${currentDependencies()}`,
    `- p620 (${realpathSync(f.p620.root)}): updated ${range}; board built; lane homes moved: far; ${currentDependencies()}`,
    `- local cardd (${f.app.root}): updated ${range}; board built; its code did not change, so it was not restarted`,
    "- vm: not targeted, not checked",
    "Reloads at each safe point (pending is not completed):",
    "Reloaded and verified:",
    "- far (mate): reload completed - reconnected on a new process",
    "- ops (mate): reload completed - reconnected on a new process",
    "Sidebars:",
    "- local: ordered",
    "- p620: ordered",
    "Board: unchanged.",
    "Main: restarts on its own conversation when this turn ends.",
  ]);
  assert.equal(callsTo(f.vmLog).length, excluded);
  assert.equal(tip(f.excludedClone.root), old);
});

test("a refusal on one selected host stops both selected hosts before any pull, and the excluded host is still never contacted", async () => {
  const f = await start();
  const old = tips(f);
  const excluded = callsTo(f.vmLog).length;
  landOnRemote(f.remote, "fleet-fix");
  writeFileSync(join(f.farHome, "README.md"), "a mate's edit\n");

  const result = await toolRun(f, { hosts: ["local", "p620"] });

  assert.equal(
    result,
    [
      "Fleet update stopped before any change: nothing was pulled, and no mate was restarted.",
      `- p620 (${realpathSync(f.p620.root)}): lane far's home ${f.farHome} has uncommitted changes: M README.md`,
      "- vm: not targeted, not checked",
    ].join("\n"),
  );
  assert.deepEqual(tips(f), old);
  assert.equal(callsTo(f.vmLog).length, excluded);
  assert.deepEqual(enrolled(f.cardd.db), []);
});

test("the default update still checks every host and refuses an upstream-only third host before any pull", async () => {
  const f = await start();
  const old = tips(f);
  landOnRemote(f.remote, "fleet-fix");

  const result = await toolRun(f, {});

  assert.match(
    result,
    new RegExp(
      `^Fleet update stopped before any change: nothing was pulled, and no mate was restarted\\.\\n- vm \\(${realpathSync(f.vm.root)}\\): no-mistakes reports "${UPSTREAM.replaceAll("(", "\\(").replaceAll(")", "\\)")}", which is not a build of the 1yian/no-mistakes fork`,
    ),
  );
  assert.deepEqual(tips(f), old);
});

test("a host list with an unknown or empty name, without local, or without cardd's host is refused before any host is contacted", async () => {
  const f = await start();
  const before = [callsTo(f.p620Log).length, callsTo(f.vmLog).length];
  const old = tips(f);

  assert.match(
    await toolRun(f, { hosts: ["local", "p62O"] }),
    /^unknown host "p62O": choose from local, p620, vm$/,
  );
  assert.match(
    await toolRun(f, { hosts: ["p620", "vm"] }),
    /^main runs on local, so a host list must include local/,
  );
  const configFile = join(f.here.root, "config", "lane.json");
  const config = parseRecord(readFileSync(configFile, "utf8"));
  const carddEntry = parseRecord(JSON.stringify(config["cardd"]));
  writeFileSync(configFile, JSON.stringify({ ...config, cardd: { ...carddEntry, host: "vm" } }));
  assert.match(
    await toolRun(f, { hosts: ["local", "p620"] }),
    /^cardd runs on vm, so a host list must include vm/,
  );

  assert.deepEqual([callsTo(f.p620Log).length, callsTo(f.vmLog).length], before);
  assert.deepEqual(tips(f), old);
});

test("a host list is refused before any host is contacted when config/lane.json has no cardd entry", async () => {
  const f = await start({ cardd: false });
  const before = [callsTo(f.p620Log).length, callsTo(f.vmLog).length];
  const old = tips(f);

  assert.match(
    await toolRun(f, { hosts: ["local", "p620"] }),
    /^a scoped update needs a cardd entry in config\/lane\.json so cardd's host can be checked/,
  );

  assert.deepEqual([callsTo(f.p620Log).length, callsTo(f.vmLog).length], before);
  assert.deepEqual(tips(f), old);
  assert.deepEqual(enrolled(f.cardd.db), []);
});

test("a host list enrolls no reload when cardd cannot scope enrollment, so an older cardd leaves every mate running", async () => {
  const f = await start({ olderCardd: true });
  const excluded = callsTo(f.vmLog).length;
  landOnRemote(f.remote, "fleet-fix");

  const said = await toolRun(f, { hosts: ["local", "p620"] });

  assert.match(said, /Unable to reload: scoped reload enrollment could not be confirmed/);
  assert.equal(callsTo(f.vmLog).length, excluded);
  assert.deepEqual(enrolled(f.cardd.db), []);
  const now = await running(f.lab);
  assert.equal(now["2ndmate-ops"], f.before["2ndmate-ops"]);
  assert.equal(now["2ndmate-far"], f.before["2ndmate-far"]);
  assert.equal(now["2ndmate-vmlane"], f.before["2ndmate-vmlane"]);
});

test("a malformed slash command or an empty host list is refused before any host is contacted, and an omitted list stays every host", async () => {
  const f = await start();
  const before = [callsTo(f.p620Log).length, callsTo(f.vmLog).length];
  const old = tips(f);

  await f.lab.submit(f.pane, "/updatefleet ,");
  const said = await until(() => {
    const [message] = updateMessages(f);
    return message;
  }, "main to record the refusal of a malformed host list");
  assert.equal(said, '[fleet] update: unknown host ",": choose from local, p620, vm');
  assert.match(await toolRun(f, { hosts: [] }), /hosts/);

  assert.deepEqual([callsTo(f.p620Log).length, callsTo(f.vmLog).length], before);
  assert.deepEqual(tips(f), old);
});
