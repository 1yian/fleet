import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { optionalString, records } from "../support/json.ts";
import { addRemote, git, landOnRemote, tip } from "../support/remote.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let remote: string;
let ghost: Session;
let marker: string;
let opsHome: string;
let farHome: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  p620 = new Scratch();
  remote = addRemote(here.root);
  git(p620.root, "remote", "add", "origin", remote);
  git(p620.root, "fetch", "-q", "origin");
  git(p620.root, "reset", "-q", "--hard", "origin/main");
  marker = join(here.parent, "p620-down");
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TRANSPORT, marker] },
    roots: { p620: p620.root },
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
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([ghost.close(), lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  p620.dispose();
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
    const [main, ops, far] = await Promise.all(["fleet-main", "fleet-ops", "fleet-far"].map(piOf));
    return main === undefined || ops === undefined || far === undefined
      ? undefined
      : { main, ops, far };
  }, "main, ops, and far to run Pi");
}

test("/updatefleet pulls origin's new commit into every home on every host, restarts every mate, then restarts main on its conversation", async () => {
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
      "Lanes:",
      "- ops (local): started",
      "- far (p620): started",
      "Board: unchanged.",
      "cardd: its code did not change, so it needs no restart.",
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
