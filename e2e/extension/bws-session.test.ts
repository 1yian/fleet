import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { FakeBws, filesHolding } from "../support/bws.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, settingsArgs, startMain } from "../support/scratch.ts";
import { toolResults } from "../support/dispatch-lab.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const STALE_TOKEN = "stale-token-in-the-lane-file";
const KEY = "E2E_API_KEY";
const OUTAGE = "Error: simulated outage";

const hashOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const HASH_COMMAND = `node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.${KEY} ?? "unset").digest("hex").slice(0, 16))'`;

let cardd: Cardd;
let h: Harness;
let scratch: Scratch;
let lab: HerdrLab | undefined;
let mainToken: string;
let opsToken: string;
let bws: FakeBws;
let apiKey: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  opsToken = cardd.addLane("ops", "main");
  apiKey = `sk-${randomUUID()}`;
  bws = new FakeBws([
    { name: "ops", secrets: { FLEET_LANE_TOKEN: opsToken, [KEY]: apiKey } },
    { name: "Common", secrets: {} },
  ]);
});
afterEach(async (t) => {
  await lab?.printIfFailed(t);
  const stopped = await Promise.allSettled([
    lab?.stop() ?? Promise.resolve(),
    h.stop(),
    cardd.stop(),
  ]);
  lab = undefined;
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const settings = (project = "ops"): Record<string, unknown> => ({
  tokenFile: bws.tokenFile,
  project,
  common: "Common",
  env: { [KEY]: KEY },
});

async function startLab(env: Record<string, string> = {}): Promise<HerdrLab> {
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    ...bws.env,
    PATH: `${BIN}:${bws.env["PATH"] ?? ""}`,
    ...env,
  });
  return lab;
}

async function screenOf(label: string): Promise<string> {
  assert.ok(lab !== undefined);
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === label);
  const listed = await lab.run([
    "pane",
    "list",
    "--workspace",
    String(workspace?.["workspace_id"]),
  ]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  return `${await lab.history(pane)}\n${await lab.screen(pane)}`;
}

async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
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

const said = (turns: readonly Turn[]): string => turns.map((turn) => turn.text).join("\n");
const everythingSaid = (): string => h.callsOf("mate").map(said).join("\n");

function assertNoLeak(secret: string, ...shown: string[]): void {
  assert.deepEqual(filesHolding(secret), [], "the secret was written to a file");
  const processes = execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" });
  assert.ok(!processes.includes(secret), "the secret is in the argv of a process");
  for (const text of [...shown, everythingSaid(), cardd.output])
    assert.ok(!text.includes(secret), "the secret shows in a transcript, screen, or log");
  const argv = bws.calls().flatMap((call) => call.args);
  assert.ok(argv.every((arg) => !arg.includes(secret) && !arg.includes(bws.accessToken)));
}

function startOps(token: string | undefined): string {
  assert.ok(lab !== undefined);
  scratch.addLane("ops", {
    url: cardd.url,
    ...(token === undefined ? {} : { token }),
    bws: settings(),
    args: [...mateArgs(h), "-e", PROBE, "-e", SHELL],
  });
  return scratch.fleet(["up", "ops"], { HERDR_SESSION: lab.name, ...bws.env }).trim();
}

async function opsRunsTheHashCommand(): Promise<string> {
  h.onModel(() => ({ tool: "bash", args: { command: HASH_COMMAND } }), "mate");
  h.onModel(() => ({ text: "checked" }), "mate");
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  const main = await cardd.connect(mainToken);
  await main.call("comment", { lane: "ops", text: "Check your environment" });
  const result = toolResults(await h.waitForCall(1, "mate", WAIT_MS)).join("\n");
  await main.close();
  return result;
}

test("a mate joins with the lane token from bws and gets its environment secrets, and no value leaks", async () => {
  await startLab();
  assert.match(startOps(STALE_TOKEN), /ops: started/);
  const result = await opsRunsTheHashCommand();
  assert.ok(result.includes(hashOf(apiKey)), `the mate's environment lacks the secret: ${result}`);

  const screen = await until(async () => {
    const text = await screenOf("2ndmate-ops");
    return text.includes(`${KEY}: from bws`) ? text : undefined;
  }, "the mate to say where its secrets came from");
  assert.match(screen, /fleet: lane token: from bws \(key FLEET_LANE_TOKEN in project ops\)/);
  assert.match(screen, new RegExp(`fleet: ${KEY}: from bws \\(key ${KEY} in project ops\\)`));
  assertNoLeak(apiKey, screen, result);
  assertNoLeak(opsToken, screen, result);
  assert.ok(!screen.includes(bws.accessToken));
});

test("a mate whose file has no token starts from bws alone", async () => {
  await startLab();
  assert.match(startOps(undefined), /ops: started/);
  const result = await opsRunsTheHashCommand();
  assert.ok(result.includes(hashOf(apiKey)));
  assertNoLeak(opsToken, result);
});

test("with bws down, the mate falls back to its file token and its environment, and says so", async () => {
  bws.failWith(OUTAGE);
  const inherited = `from-the-pane-${randomUUID()}`;
  await startLab({ [KEY]: inherited });
  assert.match(startOps(opsToken), /ops: started/);
  const result = await opsRunsTheHashCommand();
  assert.ok(result.includes(hashOf(inherited)), `the fallback value did not arrive: ${result}`);

  const screen = await until(async () => {
    const text = await screenOf("2ndmate-ops");
    return text.includes(`${KEY}: from the environment`) ? text : undefined;
  }, "the mate to say it fell back");
  assert.match(
    screen,
    /fleet: lane token: from config\/lane\.json \(bws failed: bws exited with status 1: Error: simulated/,
  );
  assert.match(screen, new RegExp(`fleet: ${KEY}: from the environment \\(bws failed:`));
  assert.ok(!screen.includes(inherited), "the fallback value shows on the screen");
  assert.ok(!everythingSaid().includes(inherited), "the fallback value is in a transcript");
});

test("a worker dispatched by a mate with a bws block gets the same environment secrets", async () => {
  cardd.addProject("fleet", { local: scratch.root });
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "auto" }),
  );
  writeFileSync(
    join(h.dir, "agent", "models.json"),
    JSON.stringify({ providers: { tier: { apiKey: "scripted" } } }),
  );
  bws = new FakeBws([
    { name: "main", secrets: { FLEET_LANE_TOKEN: mainToken, [KEY]: apiKey } },
    { name: "Common", secrets: {} },
  ]);
  const lane = await startLab();
  configureMain(scratch, cardd.url, STALE_TOKEN, {
    bws: settings("main"),
    workerArgs: [...settingsArgs(h), "-e", SHELL],
  });
  const move = (turns: Turn[]) => {
    const isWorker = turns.some((turn) => turn.text.includes("# Worker role contract"));
    const ran = toolResults(turns).length > 0;
    if (isWorker)
      return ran ? { text: "checked" } : { tool: "bash", args: { command: HASH_COMMAND } };
    return ran
      ? { text: "dispatched" }
      : {
          tool: "dispatch",
          args: {
            title: "Users see one scrollbar",
            name: "one-scrollbar",
            kind: "ship",
            project: "fleet",
            intent: "Fix the scrollbar",
            host: "local",
            task: "fix the scrollbar",
          },
        };
  };
  for (let call = 0; call < 12; call += 1) h.onModel(move, "mate");
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  await startMain(lane, scratch, h, false, settingsArgs(h));
  const asked: unknown = await cleo.call("card.new", { title: "Ship the fix", kind: "scout" });
  await cleo.call("hold", {
    card: Number(Reflect.get(Object(asked), "id")),
    question: "Ship the fix?",
    options: ["Yes"],
  });
  const seen = await until(
    () =>
      h
        .callsOf("mate")
        .map(toolResults)
        .flat()
        .find((text) => text.includes(hashOf(apiKey))),
    "the worker to read the secret from its environment",
  );
  assert.ok(seen.includes("exit 0"));
  assertNoLeak(apiKey, seen);
  await cleo.close();
});
