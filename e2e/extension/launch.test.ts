import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";
import { pathWithout } from "../support/tool-stubs.ts";

const COLD_START_WAIT_MS = 60_000;
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
  cardd.dashTokens(["mate:cleo"]);
  main = await cardd.connect(cardd.addLane("main"));
  const token = cardd.addLane("cleo", "main");
  assert.match(token, /^-/);
  scratch.addLane("cleo", { url: cardd.url, token, args: mateArgs(h) });
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([main.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const up = (): string => scratch.fleet(["up"], { HERDR_SESSION: lab.name });

async function matePane(): Promise<{ group: number; shell: number }> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const mates = workspaces.filter((each) => each["label"] === "2ndmate-cleo");
  assert.equal(mates.length, 1);
  const listed = await lab.run(["pane", "list", "--workspace", String(mates[0]?.["workspace_id"])]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  return {
    group: Number(info[0]?.["foreground_process_group_id"]),
    shell: Number(info[0]?.["shell_pid"]),
  };
}

const mainSays = async (text: string): Promise<void> => {
  await main.call("comment", { lane: "cleo", text });
};

test("fleet up starts a second mate in its own workspace once, and again on its own conversation", async () => {
  assert.equal(up(), "cleo: started in 2ndmate-cleo\n");
  await mainSays("Ship the scrollbar fix");
  await h.waitForCall(0, "mate", COLD_START_WAIT_MS);
  assert.equal(up(), "cleo: already running in 2ndmate-cleo\n");

  const { group, shell } = await matePane();
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await matePane()).group !== shell) {
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(up(), "cleo: started in 2ndmate-cleo\n");
  await mainSays("Drop the old banner");
  const turns = await h.waitForCall(1, "mate", COLD_START_WAIT_MS);
  const asks = turns.filter((turn) => turn.role === "user").map((turn) => turn.text);
  assert.deepEqual(
    asks.map((text) => text.split(":")[0]),
    ["[fleet] main on c-1 cleo", "[fleet] main on c-1 cleo"],
  );
  assert.equal(readdirSync(join(h.dir, "sessions")).length, 1);
});

function oldLavish(): string {
  const bin = join(h.dir, "old-lavish");
  mkdirSync(bin);
  writeFileSync(join(bin, "lavish-axi"), "#!/bin/sh\necho 0.1.10\n");
  chmodSync(join(bin, "lavish-axi"), 0o755);
  return [bin, pathWithout("lavish-axi")].join(delimiter);
}

for (const [state, path] of [
  ["missing", () => pathWithout("lavish-axi")],
  ["too old", oldLavish],
] as const) {
  test(`fleet up starts the mate on a host whose lavish-axi is ${state}, with no problem to fix`, async () => {
    const PATH = path();
    assert.equal(
      scratch.fleet(["up"], { HERDR_SESSION: lab.name, PATH }),
      "cleo: started in 2ndmate-cleo\n",
    );
    await mainSays("Ship the scrollbar fix");
    await h.waitForCall(0, "mate", COLD_START_WAIT_MS);
    assert.equal(
      scratch.fleet(["up"], { HERDR_SESSION: lab.name, PATH }),
      "cleo: already running in 2ndmate-cleo\n",
    );
    assert.equal(scratch.fleet(["status"], { HERDR_SESSION: lab.name, PATH }), "cleo: running\n");
  });
}
