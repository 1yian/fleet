import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { optionalString, records } from "../support/json.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
const PROMPT = "Trust project folder?";

let cleanups: (() => Promise<unknown>)[] = [];
let labs: HerdrLab[] = [];
afterEach(async (t) => {
  const run = cleanups.reverse();
  cleanups = [];
  for (const lab of labs) await lab.printIfFailed(t);
  labs = [];
  const stopped = await Promise.allSettled(run.map((each) => each()));
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function paneWhere(
  lab: HerdrLab,
  match: (pane: Record<string, unknown>) => boolean,
): Promise<string | undefined> {
  const pane = records((await lab.run(["pane", "list"]))["panes"]).find(match);
  return pane === undefined ? undefined : optionalString(pane, "pane_id");
}

async function reaches<T>(
  lab: HerdrLab,
  pane: () => Promise<string | undefined>,
  reached: () => T | undefined,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const value = reached();
    if (value !== undefined) return value;
    const found = await pane();
    const screen = found === undefined ? "" : await lab.screen(found);
    assert.ok(!screen.includes(PROMPT), `Pi asked for project trust before ${what}:\n${screen}`);
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("a freshly dispatched worker on a project that needs trust starts straight into work", async () => {
  const parts: DispatchLab = await startDispatchLab({ needsTrust: true });
  cleanups.push(() => stopDispatchLab(parts));
  const { h, lab, mate } = parts;
  labs.push(lab);
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "local",
        task: "fix the scrollbar",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ text: "working on it" }), "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const first = await reaches(
    lab,
    () => paneWhere(lab, (pane) => String(pane["cwd"]).endsWith(".worktrees/c-1-a1")),
    () => h.callsOf("worker")[0],
    "the dispatched worker's first model call",
  );
  assert.match(lastUser(first) ?? "", /^\[fleet\] main on c-1 one-scrollbar: fix the scrollbar/);
});

async function laneFixture(): Promise<{
  cardd: Cardd;
  h: Harness;
  lab: HerdrLab;
  scratch: Scratch;
  home: string;
  mainToken: string;
}> {
  const cardd = await Cardd.start();
  cleanups.push(() => cardd.stop());
  const h = await Harness.start();
  cleanups.push(() => h.stop());
  const scratch = new Scratch();
  cleanups.push(() => {
    scratch.dispose();
    return Promise.resolve();
  });
  const lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  cleanups.push(() => lab.stop());
  labs.push(lab);
  const mainToken = cardd.addLane("main");
  const args = [...mateArgs(h).filter((arg) => arg !== "--approve"), "-e", PROBE];
  const home = scratch.addLane("ops", {
    url: cardd.url,
    token: cardd.addLane("ops", "main"),
    args,
  });
  return { cardd, h, lab, scratch, home, mainToken };
}

const mateWorkspace = async (lab: HerdrLab): Promise<string | undefined> => {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const found = workspaces.find((each) => each["label"] === "2ndmate-ops");
  const id = found === undefined ? undefined : optionalString(found, "workspace_id");
  if (id === undefined) return undefined;
  return optionalString(
    records((await lab.run(["pane", "list", "--workspace", id]))["panes"])[0] ?? {},
    "pane_id",
  );
};

test("a mate that fleet starts and restarts on a project that needs trust reaches work without a trust prompt", async () => {
  const { cardd, h, lab, scratch, mainToken } = await laneFixture();
  const main = await cardd.connect(mainToken);
  cleanups.push(() => main.close());
  const fleet = (...args: string[]): string => scratch.fleet(args, { HERDR_SESSION: lab.name });
  h.onModel(() => ({ text: "noted" }), "mate");

  assert.match(fleet("up", "ops"), /ops: started/);
  await reaches(
    lab,
    () => mateWorkspace(lab),
    () => h.events.find((event) => event["type"] === "fleet_connected"),
    "the started mate to join the fleet",
  );
  await main.call("comment", { lane: "ops", text: "Are you there?" });
  const first = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(first.map((turn) => turn.text).join("\n"), /Are you there\?/);

  assert.match(fleet("restart", "ops"), /ops: started/);
  await reaches(
    lab,
    () => mateWorkspace(lab),
    () => h.events.filter((event) => event["type"] === "fleet_connected")[1],
    "the restarted mate to join the fleet",
  );
  await main.call("comment", { lane: "ops", text: "Still there?" });
  const second = await h.waitForCall(1, "mate", WAIT_MS);
  assert.match(second.map((turn) => turn.text).join("\n"), /Still there\?/);
});

test("a mate that main relaunches from the command line of an older fleet starts without a trust prompt", async () => {
  const { cardd, h, lab, scratch, home, mainToken } = await laneFixture();
  const main = await cardd.connect(mainToken);
  cleanups.push(() => main.close());
  h.onModel(() => ({ text: "noted" }), "mate");
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    home,
    "--label",
    "2ndmate-ops",
    "--no-focus",
  ]);
  const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  const exited = spawnSync("true").pid;
  const args = [...mateArgs(h).filter((arg) => arg !== "--approve"), "-e", PROBE];

  execFileSync(
    process.execPath,
    [
      join(scratch.root, "packages", "extension", "src", "relaunch.ts"),
      String(exited),
      pane,
      home,
      ...args,
    ],
    { env: { ...process.env, ...lab.env, HERDR_SESSION: lab.name } },
  );
  await reaches(
    lab,
    () => Promise.resolve(pane),
    () => h.events.find((event) => event["type"] === "fleet_connected"),
    "the relaunched mate to join the fleet",
  );
  await main.call("comment", { lane: "ops", text: "Are you back?" });
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(turns.map((turn) => turn.text).join("\n"), /Are you back\?/);
});
