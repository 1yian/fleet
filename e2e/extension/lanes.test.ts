import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { isRecord, records, type JsonRecord } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let ghost: Session;
let marker: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  p620 = new Scratch();
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
  here.addLane("ops", settings("ops"));
  p620.addLane("far", settings("far"));
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
  detail?: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}\n${(await detail?.()) ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function rowsOf(host: Scratch, args: readonly string[]): JsonRecord[] {
  const parsed: unknown = JSON.parse(host.fleet([...args, "--json"], { HERDR_SESSION: lab.name }));
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

const states = (host: Scratch): Record<string, string> =>
  Object.fromEntries(
    rowsOf(host, ["status"]).map((row) => [String(row["lane"]), String(row["state"])]),
  );
const waitState = (host: Scratch, lane: string, state: string) =>
  until(
    () => (states(host)[lane] === state ? true : undefined),
    `${lane} to be ${state}`,
    async () => {
      const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
      const workspace = workspaces.find((each) => each["label"] === `fleet-${lane}`);
      const listed = await lab.run([
        "pane",
        "list",
        "--workspace",
        String(workspace?.["workspace_id"]),
      ]);
      const pane = String(records(listed["panes"])[0]?.["pane_id"]);
      const info = JSON.stringify(
        (await lab.run(["pane", "process-info", "--pane", pane]))["process_info"],
      );
      return `status: ${JSON.stringify(states(host))}\nprocesses: ${info}\nscreen:\n${await lab.screen(pane)}`;
    },
  );

async function groupOf(lane: string): Promise<number> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === `fleet-${lane}`);
  const listed = await lab.run([
    "pane",
    "list",
    "--workspace",
    String(workspace?.["workspace_id"]),
  ]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  return Number(info[0]?.["foreground_process_group_id"]);
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

test("main brings up every lane on both hosts, and starts a mate that dies", async () => {
  h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, here, h);
  await waitState(here, "ops", "running");
  await waitState(p620, "far", "running");

  await until(async () => {
    const screen = await lab.screen(pane);
    return screen.includes("far started on p620") && screen.includes("ops started on local")
      ? true
      : undefined;
  }, "main to say what it started");
  await wakeMain("Ship the scrollbar fix");
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(users(turns), /\[fleet\] lanes: ops started on local/);
  assert.match(users(turns), /\[fleet\] lanes: far started on p620/);

  const before = await groupOf("far");
  process.kill(-before, "SIGKILL");
  await until(
    async () => ((await groupOf("far")) === before ? undefined : true),
    "far to leave its old Pi",
  );
  await waitState(p620, "far", "running");
  assert.notEqual(await groupOf("far"), before);
});

test("main tells the captain when a host cannot be reached, and when it is back", async () => {
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  await waitState(p620, "far", "running");
  writeFileSync(marker, "down");
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(users(turns), /\[fleet\] lanes: p620 cannot be reached/);

  rmSync(marker);
  await until(
    () => (sessionText().includes("p620 can be reached again") ? true : undefined),
    "main to learn p620 is back",
  );
  await wakeMain("Drop the old banner");
  const next = await h.waitForCall(1, "mate", WAIT_MS);
  assert.match(users(next), /\[fleet\] lanes: p620 can be reached again/);
});

test("a mate that keeps dying is held, and only naming it starts it again", async () => {
  const loopy = cardd.addLane("loopy", "main");
  here.addLane("loopy", {
    url: cardd.url,
    token: `-${loopy}`,
    args: ["--approve", "--definitely-not-an-option"],
  });
  const actionOf = (lane: string): unknown =>
    rowsOf(here, ["up"]).find((row) => row["lane"] === lane)?.["action"];
  for (let start = 1; start <= 3; start += 1) {
    assert.equal(actionOf("loopy"), "started");
    await waitState(here, "loopy", "down");
  }
  assert.equal(actionOf("loopy"), "held");
  assert.equal(states(here)["loopy"], "stopped");
  assert.match(here.fleet(["up"], { HERDR_SESSION: lab.name }), /loopy: stopped: crash loop/);
  assert.match(here.fleet(["up", "loopy"], { HERDR_SESSION: lab.name }), /^loopy: started/);
});

test("main stops, restarts, and starts lanes with lane, its board shows them, and it never starts a lane held by hand", async () => {
  let kicked: number | undefined;
  h.onModel(() => ({ tool: "lane", args: { name: "ops", action: "stop" } }), "mate");
  h.onModel(async (turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /^ops \(local\): stopped$/);
    kicked = await groupOf("far");
    process.kill(-kicked, "SIGKILL");
    await until(async () => ((await groupOf("far")) === kicked ? undefined : true), "far to die");
    await waitState(p620, "far", "running");
    assert.equal(states(here)["ops"], "stopped");
    return { tool: "board", args: {} };
  }, "mate");
  h.onModel((turns) => {
    const board = toolResults(turns).at(-1) ?? "";
    assert.match(board, /^lanes\[2\]\{name,state\}:\n {2}ops,stopped\n {2}far,running$/m);
    assert.match(board, /^ {2}Call `board\(lanes=true\)` to see why a lane is down or stopped$/m);
    assert.match(
      board,
      /^ {2}Call `lane\(name=<lane>, action="start"\)` to start a lane that is down or stopped$/m,
    );
    return { tool: "board", args: { lanes: true } };
  }, "mate");
  h.onModel((turns) => {
    const board = toolResults(turns).at(-1) ?? "";
    assert.match(board, /^ {2}ops,local,stopped,stopped by hand$/m);
    assert.match(board, /^lanes\[2\]\{name,host,state,detail\}:$/m);
    assert.match(board, /^ {2}far,p620,running,""$/m);
    assert.doesNotMatch(board, /board\(lanes=true\)/);
    return { tool: "lane", args: { name: "all", action: "stop" } };
  }, "mate");
  h.onModel((turns) => {
    assert.equal(
      toolResults(turns).at(-1),
      'lane "all" only restarts: name each lane to start or stop it',
    );
    return { tool: "lane", args: { name: "all", action: "restart" } };
  }, "mate");
  h.onModel((turns) => {
    const restart = toolResults(turns).at(-1) ?? "";
    assert.match(restart, /far \(p620\): started/);
    assert.match(restart, /ops \(local\): stopped - stopped by hand/);
    return { tool: "lane", args: { name: "ops", action: "start" } };
  }, "mate");
  h.onModel(() => ({ text: "all lanes run" }), "mate");
  await startMain(lab, here, h);
  await waitState(here, "ops", "running");
  await waitState(p620, "far", "running");
  await wakeMain("Check the lanes");
  const turns = await h.waitForCall(6, "mate", WAIT_MS);
  assert.match(
    turns.filter((turn) => turn.role === "toolResult").at(-1)?.text ?? "",
    /^ops \(local\): started$/,
  );
  await waitState(here, "ops", "running");
});
