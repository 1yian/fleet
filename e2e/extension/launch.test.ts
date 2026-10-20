// fleet up (docs/setup.md). It starts a second mate in its own herdr workspace, once, and starts
// a dead mate again on its own conversation. The mate is a real Pi that runs in its home, a
// worktree of a scratch copy of this repository, so it loads the fleet extension from that
// copy's .pi/settings.json with no -e flag. It talks to the scripted fake model, in a herdr lab.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

// herdr starts the mate's Pi cold, which can take tens of seconds on a busy CI runner.
const START_WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let main: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  main = await cardd.connect(cardd.addLane("main"));
  const token = cardd.addLane("cleo", "main");
  scratch.addLane("cleo", { url: cardd.url, token, args: mateArgs(h) });
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async () => {
  // Stop everything even if one part fails, so no process outlives the test.
  const stopped = await Promise.allSettled([main.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const up = (): string => scratch.fleet(["up"], { HERDR_SESSION: lab.name });

/** The foreground process group and shell of the mate's pane in workspace fleet-cleo. */
async function matePane(): Promise<{ group: number; shell: number }> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const mates = workspaces.filter((each) => each["label"] === "fleet-cleo");
  assert.equal(mates.length, 1);
  const listed = await lab.run(["pane", "list", "--workspace", String(mates[0]?.["workspace_id"])]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  return {
    group: Number(info[0]?.["foreground_process_group_id"]),
    shell: Number(info[0]?.["shell_pid"]),
  };
}

/** Main's comment on cleo's lane card wakes cleo for one turn. */
const mainSays = async (text: string): Promise<void> => {
  await main.call("comment", { lane: "cleo", text });
};

test("fleet up starts a second mate in its own workspace once, and again on its own conversation", async () => {
  assert.equal(up(), "cleo: started in fleet-cleo\n");
  await mainSays("Ship the scrollbar fix");
  await h.waitForCall(0, "mate", START_WAIT_MS);
  assert.equal(up(), "cleo: already running in fleet-cleo\n");

  const { group, shell } = await matePane();
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await matePane()).group !== shell) {
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(up(), "cleo: started in fleet-cleo\n");
  await mainSays("Drop the old banner");
  const turns = await h.waitForCall(1, "mate", START_WAIT_MS);
  // The restarted mate still has its first conversation, and the first comment came only once.
  const asks = turns.filter((turn) => turn.role === "user").map((turn) => turn.text);
  assert.deepEqual(
    asks.map((text) => text.split(":")[0]),
    ["[fleet] main on c-1", "[fleet] main on c-1"],
  );
  assert.equal(readdirSync(join(h.dir, "sessions")).length, 1);
});
