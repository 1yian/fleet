import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { optionalString, parseRecord, records } from "../support/json.ts";
import { addRemote, git, landOnRemote, tip } from "../support/remote.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../packages/cardd/migrations", import.meta.url));
const SCHEMA = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).length;
const NEXT_MIGRATION = `packages/cardd/migrations/${String(SCHEMA + 1).padStart(3, "0")}-update.sql`;
const CARDD_WAIT_S = 15;

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let app: Scratch;
let remote: string;
let ghost: Session;
let marker: string;
let opsHome: string;
let farHome: string;
function cloneOf(remote: string, name: string): Scratch {
  const scratch = new Scratch(name);
  git(scratch.root, "remote", "add", "origin", remote);
  git(scratch.root, "fetch", "-q", "origin");
  git(scratch.root, "reset", "-q", "--hard", "origin/main");
  return scratch;
}

beforeEach(async () => {
  h = await Harness.start();
  here = new Scratch();
  remote = addRemote(here.root);
  p620 = cloneOf(remote, "fleet");
  app = cloneOf(remote, "app");
  cardd = await Cardd.underKeepAlive(app.root);
  marker = join(here.parent, "p620-down");
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TRANSPORT, marker] },
    roots: { p620: p620.root },
    cardd: { root: app.root, db: cardd.db, restart: cardd.restartCommand },
  });
  const settings = (lane: string) => ({
    url: cardd.url,
    token: cardd.addLane(lane, "main"),
    args: mateArgs(h),
  });
  opsHome = here.addLane("ops", settings("ops"));
  farHome = p620.addLane("far", settings("far"));
  ghost = await cardd.connect(cardd.addLane("ghost", "main"));
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "1000",
    FLEET_CARDD_WAIT_MS: String(CARDD_WAIT_S * 1000),
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([ghost.close(), lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  p620.dispose();
  app.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

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

async function paneOf(label: string): Promise<string | undefined> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === label);
  if (workspace === undefined) return undefined;
  const listed = await lab.run(["pane", "list", "--workspace", String(workspace["workspace_id"])]);
  const pane = records(listed["panes"])[0];
  return pane === undefined ? undefined : optionalString(pane, "pane_id");
}

async function piOf(label: string): Promise<number | undefined> {
  const pane = await paneOf(label);
  if (pane === undefined) return undefined;
  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  const pi = records(info[0]?.["foreground_processes"]).find(
    (each) => each["name"] === "pi" || each["argv0"] === "pi",
  );
  return pi === undefined ? undefined : Number(pi["pid"]);
}

const sessionText = (): string =>
  readdirSync(join(h.dir, "sessions"))
    .map((file) => readFileSync(join(h.dir, "sessions", file), "utf8"))
    .join("\n");

async function wakeMain(title: string): Promise<void> {
  const card: unknown = await ghost.call("card.new", { title, kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await ghost.call("hold", {
    card: id,
    question: `${title}?`,
    options: ["Yes"],
  });
}

const users = (turns: Turn[]): string =>
  turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("\n");

async function fleetRunning(): Promise<{ main: number; ops: number; far: number }> {
  return until(async () => {
    const [main, ops, far] = await Promise.all(["1stmate", "2ndmate-ops", "2ndmate-far"].map(piOf));
    return main === undefined || ops === undefined || far === undefined
      ? undefined
      : { main, ops, far };
  }, "main, ops, and far to run Pi");
}

test("/updatefleet pulls origin's new commit into every home on every host and cardd's checkout, leaves cardd running when its code did not change, restarts every mate, then restarts main on its conversation", async () => {
  const pane = await startMain(lab, here, h);
  const before = await fleetRunning();
  const old = tip(here.root);
  const fresh = landOnRemote(remote, "fleet-fix");

  await lab.submit(pane, "/updatefleet");
  await until(
    () => (sessionText().includes("[fleet] update: Fleet updated.") ? true : undefined),
    "main to record the update's report",
  );
  const after = await until(async () => {
    const now = await fleetRunning();
    return now.main !== before.main && now.ops !== before.ops && now.far !== before.far
      ? now
      : undefined;
  }, "every mate and main to run a new Pi");
  assert.notEqual(after.main, before.main);

  for (const home of [here.root, opsHome, p620.root, farHome])
    assert.equal(tip(home, "HEAD"), fresh);
  assert.equal(readFileSync(join(opsHome, "fleet-fix.txt"), "utf8"), "fleet-fix\n");
  assert.equal(readFileSync(join(farHome, "fleet-fix.txt"), "utf8"), "fleet-fix\n");

  h.onModel(() => ({ text: "noted" }), "mate");
  const calls = h.callsOf("mate").length;
  await wakeMain("Check the update");
  const turns = await h.waitForCall(calls, "mate", WAIT_MS);
  const said = users(turns);
  const range = `${old.slice(0, 7)}..${fresh.slice(0, 7)} (1 commit)`;
  const start = said.indexOf("[fleet] update:");
  const report = said.slice(start, said.indexOf("\n", said.indexOf("Main: restarts", start)));
  assert.equal(
    report,
    [
      "[fleet] update: Fleet updated.",
      "Hosts:",
      `- local (${realpathSync(here.root)}): updated ${range}; board built; lane homes moved: ops`,
      `- p620 (${realpathSync(p620.root)}): updated ${range}; board built; lane homes moved: far`,
      `- local cardd (${app.root}): updated ${range}; board built; its code did not change, so it was not restarted`,
      "Lanes:",
      "- ops (local): started",
      "- far (p620): started",
      "Board: unchanged.",
      "Main: restarts on its own conversation when this turn ends.",
    ].join("\n"),
  );
  assert.match(said, /Check the update\?/);
});

test("update_fleet stops before any change when a lane home has uncommitted changes or a host cannot be reached", async () => {
  h.onModel(() => ({ tool: "update_fleet", args: {} }), "mate");
  let result = "";
  h.onModel((turns) => {
    result = toolResults(turns).at(-1) ?? "";
    return { text: "the update stopped" };
  }, "mate");
  await startMain(lab, here, h);
  const before = await fleetRunning();
  const old = tip(here.root);
  landOnRemote(remote, "fleet-fix");
  writeFileSync(join(opsHome, "README.md"), "a mate's edit\n");
  writeFileSync(marker, "down");

  await wakeMain("Update the fleet");
  await h.waitForCall(1, "mate", WAIT_MS);
  assert.equal(
    result,
    [
      "Fleet update stopped before any change: nothing was pulled, and no mate was restarted.",
      `- local (${realpathSync(here.root)}): lane ops's home ${opsHome} has uncommitted changes: M README.md`,
      "- p620: cannot be reached - sh on p620 failed: ssh: connect to host far port 22: Operation timed out",
    ].join("\n"),
  );
  for (const home of [here.root, opsHome, p620.root, farHome]) assert.equal(tip(home, "HEAD"), old);
  assert.equal(readFileSync(join(opsHome, "README.md"), "utf8"), "a mate's edit\n");
  assert.deepEqual(await fleetRunning(), before);
});

const schemaOf = (db: string): number => {
  const open = new DatabaseSync(db, { readOnly: true });
  try {
    return Number(open.prepare("PRAGMA user_version").get()?.["user_version"]);
  } finally {
    open.close();
  }
};

const backups = (): string[] =>
  readdirSync(dirname(cardd.db))
    .filter((name) => /^cards-backup-.+\.db$/.test(name))
    .map((name) => join(dirname(cardd.db), name));

const liveMates = (): string[] => {
  const open = new DatabaseSync(cardd.db, { readOnly: true });
  try {
    return open
      .prepare(
        "SELECT lane FROM sessions WHERE role = 'mate' AND state IN ('idle', 'running', 'waiting') ORDER BY lane",
      )
      .all()
      .map((row) => String(row["lane"]));
  } finally {
    open.close();
  }
};

async function carddCommit(): Promise<string | undefined> {
  const response = await fetch(
    cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/api/version"),
  );
  const body: unknown = await response.json();
  const commit: unknown = Reflect.get(Object(body), "commit");
  return typeof commit === "string" ? commit : undefined;
}

test("/updatefleet backs up cardd's database and restarts cardd on the new code with its migrations before it restarts the lanes, and every mate reconnects", async () => {
  const pane = await startMain(lab, here, h);
  const before = await fleetRunning();
  const old = tip(here.root);
  assert.equal(await carddCommit(), old);
  const fresh = landOnRemote(
    remote,
    "cardd-change",
    NEXT_MIGRATION,
    "CREATE TABLE update_probe (id INTEGER PRIMARY KEY) STRICT;\n",
  );

  await lab.submit(pane, "/updatefleet");
  await until(
    () => (sessionText().includes("[fleet] update: Fleet updated.") ? true : undefined),
    "main to record the update's report",
  );
  await until(async () => {
    const now = await fleetRunning();
    return now.main !== before.main && now.ops !== before.ops && now.far !== before.far
      ? now
      : undefined;
  }, "every mate and main to run a new Pi");

  assert.equal(await carddCommit(), fresh);
  assert.equal(tip(app.root, "HEAD"), fresh);
  const [backup, ...more] = backups();
  assert.equal(more.length, 0);
  assert.ok(backup !== undefined);
  assert.equal(schemaOf(backup), SCHEMA);
  assert.equal(schemaOf(cardd.db), SCHEMA + 1);
  await until(
    () => (liveMates().join(",") === "far,main,ops" ? true : undefined),
    "main, ops, and far to reconnect to the restarted cardd",
  );

  await ghost.close();
  ghost = await cardd.connect(cardd.addLane("ghost2", "main"));
  h.onModel(() => ({ text: "noted" }), "mate");
  const calls = h.callsOf("mate").length;
  await wakeMain("Check cardd");
  const said = users(await h.waitForCall(calls, "mate", WAIT_MS));
  const range = `${old.slice(0, 7)}..${fresh.slice(0, 7)} (1 commit)`;
  const start = said.indexOf("[fleet] update:");
  assert.equal(
    said.slice(start, said.indexOf("\nLanes:", start)),
    [
      "[fleet] update: Fleet updated.",
      "Hosts:",
      `- local (${realpathSync(here.root)}): updated ${range}; board built; lane homes moved: ops`,
      `- p620 (${realpathSync(p620.root)}): updated ${range}; board built; lane homes moved: far`,
      `- local cardd (${app.root}): updated ${range}; board built; database backed up to ${backup}; restarted and answers on ${fresh.slice(0, 7)}; schema ${String(SCHEMA)} -> ${String(SCHEMA + 1)}`,
    ].join("\n"),
  );
  assert.match(said, /Check cardd\?/);
});

test("/updatefleet reads config/lane.json when it runs, so a cardd entry added after main started still pulls cardd's checkout and restarts cardd", async () => {
  const configFile = join(here.root, "config", "lane.json");
  const { cardd: entry, ...withoutCardd } = parseRecord(readFileSync(configFile, "utf8"));
  writeFileSync(configFile, JSON.stringify(withoutCardd));
  const pane = await startMain(lab, here, h);
  const before = await fleetRunning();
  const old = tip(app.root);
  assert.equal(await carddCommit(), old);
  writeFileSync(configFile, JSON.stringify({ ...withoutCardd, cardd: entry }));
  const fresh = landOnRemote(remote, "cardd-change", NEXT_MIGRATION, "SELECT 1;\n");

  await lab.submit(pane, "/updatefleet");
  await until(
    () => (sessionText().includes("[fleet] update: Fleet updated.") ? true : undefined),
    "main to record the update's report",
  );
  await until(async () => {
    const now = await fleetRunning();
    return now.main !== before.main && now.ops !== before.ops && now.far !== before.far
      ? now
      : undefined;
  }, "every mate and main to run a new Pi");

  assert.equal(tip(app.root, "HEAD"), fresh);
  assert.equal(await carddCommit(), fresh);
  assert.equal(backups().length, 1);
  assert.match(sessionText(), /local cardd \(.*restarted and answers on/);
});

test("update_fleet stops before any lane restarts when cardd does not come back on the new code", async () => {
  h.onModel(() => ({ tool: "update_fleet", args: {} }), "mate");
  let result = "";
  h.onModel((turns) => {
    result = toolResults(turns).at(-1) ?? "";
    return { text: "the update stopped" };
  }, "mate");
  await startMain(lab, here, h);
  const before = await fleetRunning();
  const old = tip(here.root);
  const fresh = landOnRemote(remote, "broken-migration", NEXT_MIGRATION, "THIS IS NOT SQL;\n");

  await wakeMain("Update the fleet");
  await h.waitForCall(1, "mate", WAIT_MS);

  const [backup] = backups();
  const range = `${old.slice(0, 7)}..${fresh.slice(0, 7)} (1 commit)`;
  assert.equal(
    result,
    [
      "Fleet update stopped: cardd does not run the new code, so no mate was restarted, and main keeps running.",
      "Hosts:",
      `- local (${realpathSync(here.root)}): updated ${range}; board built; lane homes moved: ops`,
      `- p620 (${realpathSync(p620.root)}): updated ${range}; board built; lane homes moved: far`,
      `- local cardd (${app.root}): updated ${range}; board built; database backed up to ${backup ?? ""}; restarted, but it did not answer on ${fresh.slice(0, 7)} within ${String(CARDD_WAIT_S)} s`,
    ].join("\n"),
  );
  assert.deepEqual(await fleetRunning(), before);
  assert.equal(schemaOf(cardd.db), SCHEMA);
});
