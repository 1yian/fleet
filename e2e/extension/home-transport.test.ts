import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { quote } from "@fleet/protocol/route";
import { Cardd } from "../support/cardd.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { parseRecord, records } from "../support/json.ts";
import { cloneWithRemote } from "../support/remote.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

const SWITCH = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
let scratch: Scratch;
let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;

beforeEach(async () => {
  scratch = new Scratch();
  cardd = await Cardd.start();
  cardd.addLane("main");
  h = await Harness.start();
  lab = await HerdrLab.start({
    ...h.piEnv("worker"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
});

afterEach(async (t) => {
  await lab.printIfFailed(t);
  await Promise.all([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
});

const homeOf = (lane: string): string => join(`${scratch.root}.worktrees`, `lane-${lane}`);
const configFile = (lane: string): string => join(homeOf(lane), "config", "lane.json");
const configOf = (lane: string) => parseRecord(readFileSync(configFile(lane), "utf8"));

function setup(lane: string, hosts: unknown = {}, roots: unknown = {}): void {
  const token = cardd.addLane(lane, "main", homeOf(lane));
  scratch.addLane(lane, {
    url: cardd.url,
    token,
    host: "p620",
    hosts,
    roots,
    args: mateArgs(h),
    tier: "fake/scripted",
  });
  scratch.fleet([
    "home",
    "set",
    lane,
    "--worker-args",
    JSON.stringify([...h.piArgs(), "-e", SHELL]),
  ]);
  writeFileSync(join(homeOf(lane), "data", "charter.md"), `${lane} private charter\n`);
  writeFileSync(join(homeOf(lane), "config", "optchat.json"), '{"enabled":false}');
}

function run(args: readonly string[]) {
  return spawnSync("node", [scratch.launch, ...args], { encoding: "utf8" });
}

async function startMate(lane: string, connected: number): Promise<void> {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    homeOf(lane),
    "--label",
    lane,
    "--no-focus",
  ]);
  const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  const piArgs = [...mateArgs(h), "-e", PROBE, "-e", SHELL];
  await lab.submit(
    pane,
    `cd ${quote(homeOf(lane))} && ${Object.entries(h.piEnv(lane))
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ")} pi ${piArgs.map(quote).join(" ")}`,
  );
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    connected,
    "the lane to connect",
  );
  await lab.submit(pane, "Verify the maverick transport now.");
}

test("supported transport setup merges a reference route into every home and new mates dispatch harmless children", async () => {
  const via = ["node", SWITCH, join(scratch.parent, "route-down")];
  const roots = { maverick: scratch.root };
  setup("yang-auto", { maverick: via }, roots);
  for (const lane of ["cleo", "fleet"])
    setup(lane, { other: ["ssh", "other"] }, { other: "/kept" });
  const lanes = ["cleo", "fleet", "yang-auto"];
  const before = new Map(lanes.map((lane) => [lane, configOf(lane)]));
  const args = ["home", "transport", "maverick", "all", "--from", "yang-auto"];
  const merged = run(args);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stdout, /Running mates are unchanged/);
  const unactivated = run(["home", "transport", "maverick", "--check"]);
  assert.notEqual(unactivated.status, 0);
  assert.match(unactivated.stderr, /no transport for maverick/);
  for (const lane of lanes) {
    const previous = before.get(lane);
    assert.ok(previous);
    assert.deepEqual(configOf(lane), {
      ...previous,
      hosts: { ...parseRecord(JSON.stringify(previous["hosts"])), maverick: via },
      roots: { ...parseRecord(JSON.stringify(previous["roots"])), ...roots },
    });
    assert.equal(
      readFileSync(join(homeOf(lane), "data", "charter.md"), "utf8"),
      `${lane} private charter\n`,
    );
  }
  const bytes = lanes.map((lane) => readFileSync(configFile(lane), "utf8"));
  assert.equal(run(args).status, 0);
  assert.deepEqual(
    lanes.map((lane) => readFileSync(configFile(lane), "utf8")),
    bytes,
  );
  const { clone } = cloneWithRemote(scratch.parent, "site");
  cardd.addProject("site", { maverick: clone }, "acme/site");
  for (const [index, lane] of lanes.entries()) {
    const workerCall = h.callsOf("worker").length;
    h.onModel(() => ({ tool: "board", args: {} }), lane);
    h.onModel(
      () => ({
        tool: "bash",
        args: {
          command: `${quote(join(scratch.root, "bin", "fleet"))} home transport maverick --check`,
        },
      }),
      lane,
    );
    h.onModel(
      () => ({
        tool: "dispatch",
        args: {
          title: `Read-only ${lane} transport proof`,
          name: `route-${lane}`,
          kind: "scout",
          project: "site",
          host: "maverick",
          intent: "Verify the transport without changing project files",
          task: "Run printf transport-proof and report the output",
        },
      }),
      lane,
    );
    h.onModel(() => ({ text: "waiting for proof" }), lane);
    h.onModel(() => ({ text: "proof received" }), lane);
    h.onModel(() => ({ tool: "bash", args: { command: "printf transport-proof" } }), "worker");
    h.onModel(
      () => ({ tool: "report", args: { status: "done", text: "transport-proof" } }),
      "worker",
    );
    h.onModel(() => ({ text: "read-only proof complete" }), "worker");
    await startMate(lane, index + 1);
    const dispatched = toolResults(await h.waitForCall(3, lane, 60_000)).join("\n");
    assert.match(dispatched, /fleet-transport-ok\s*exit 0/);
    assert.match(dispatched, /Dispatched .* on maverick/);
    const child = await h.waitForCall(workerCall + 1, "worker", 60_000);
    assert.ok(toolResults(child).some((text) => text.includes("transport-proofexit 0")));
    await h.waitForCall(workerCall + 2, "worker", 60_000);
    await h.waitForCall(4, lane, 60_000);
  }
});

test("transport setup preserves held homes and existing roots when the reference uses the default", () => {
  const via = ["node", SWITCH, join(scratch.parent, "route-down")];
  setup("yang-auto", { maverick: via });
  setup("kalshi", { other: ["ssh", "other"] }, { maverick: "/existing/fleet" });
  const stopped = join(homeOf("kalshi"), "state", "stopped");
  writeFileSync(stopped, "stopped by main\n");
  const before = configOf("kalshi");
  const done = run(["home", "transport", "maverick", "kalshi", "--from", "yang-auto"]);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(configOf("kalshi"), {
    ...before,
    hosts: { other: ["ssh", "other"], maverick: via },
  });
  assert.equal(readFileSync(stopped, "utf8"), "stopped by main\n");
});

test("transport setup refuses absent or unsupported canonical mappings without changing homes", () => {
  setup("cleo");
  setup("reference", { maverick: "ssh maverick" });
  const before = readFileSync(configFile("cleo"), "utf8");
  for (const reference of ["missing", "cleo", "reference"]) {
    const done = run(["home", "transport", "maverick", "all", "--from", reference]);
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /no lane missing|no supported transport for maverick/);
    assert.equal(readFileSync(configFile("cleo"), "utf8"), before);
  }
});
