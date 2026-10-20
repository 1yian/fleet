// fleet up (docs/setup.md). It starts each lane's mate in its own herdr workspace,
// once, and starts a dead mate again on its own conversation. The mate is a real
// Pi with the fleet extension and the scripted fake model, in a herdr lab session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

// herdr starts the mate's Pi cold, which can take tens of seconds on a busy CI runner.
const START_WAIT_MS = 60_000;
const LAUNCH = fileURLToPath(new URL("../../packages/extension/src/launch.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let config: string;
let cleo: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  const home = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const token = cardd.addLane("main", undefined, home);
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  config = mkdtempSync(join(tmpdir(), "fleet-config-"));
  const lane = { url: cardd.url, token, home, args: h.piArgs() };
  writeFileSync(join(config, "main.json"), JSON.stringify(lane));
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async () => {
  // Stop everything even if one part fails, so no process outlives the test.
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const up = (): string =>
  execFileSync("node", [LAUNCH, "up"], {
    encoding: "utf8",
    env: { ...process.env, FLEET_CONFIG_DIR: config, HERDR_SESSION: lab.name },
  });

/** The foreground process group and shell of the mate's pane in workspace fleet-main. */
async function matePane(): Promise<{ group: number; shell: number }> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const mates = workspaces.filter((each) => each["label"] === "fleet-main");
  assert.equal(mates.length, 1);
  const listed = await lab.run(["pane", "list", "--workspace", String(mates[0]?.["workspace_id"])]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  return {
    group: Number(info[0]?.["foreground_process_group_id"]),
    shell: Number(info[0]?.["shell_pid"]),
  };
}

/** A second mate's hold wakes main for one turn. Cleo's lane card is c-1, so its cards start at c-2. */
async function cleoAsks(title: string): Promise<void> {
  const card: unknown = await cleo.call("card.new", { title, kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await cleo.call("hold", { card: id, question: `${title}?`, options: ["Yes"] });
}

test("fleet up starts the mate in its own workspace once, and again on its own conversation", async () => {
  assert.equal(up(), "main: started in fleet-main\n");
  await cleoAsks("Ship the scrollbar fix");
  await h.waitForCall(0, "mate", START_WAIT_MS);
  assert.equal(up(), "main: already running in fleet-main\n");

  const { group, shell } = await matePane();
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await matePane()).group !== shell) {
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(up(), "main: started in fleet-main\n");
  await cleoAsks("Drop the old banner");
  const turns = await h.waitForCall(1, "mate", START_WAIT_MS);
  // The restarted mate still has its first conversation, and the first question came only once.
  const asks = turns.filter((turn) => turn.role === "user").map((turn) => turn.text);
  assert.deepEqual(
    asks.map((text) => text.split(":")[0]),
    ["[fleet] cleo on c-2 (hold)", "[fleet] cleo on c-3 (hold)"],
  );
  assert.equal(readdirSync(join(h.dir, "sessions")).length, 1);
});
