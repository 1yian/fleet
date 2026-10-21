import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { LifecycleHolder } from "../support/lifecycle-holder.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const CONTENDED_WAIT_MS = "300";
const CONCURRENT_CALLERS = 4;

interface Finished {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
}

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let home: string;
let owner: LifecycleHolder | undefined;
beforeEach(async () => {
  owner = undefined;
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  cardd.addLane("main");
  scratch.addLane("ops", {
    url: cardd.url,
    token: cardd.addLane("ops", "main"),
    args: mateArgs(h),
  });
  home = join(`${scratch.root}.worktrees`, "lane-ops");
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  await owner?.crash();
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const fleet = (args: readonly string[], env: Record<string, string> = {}): Promise<Finished> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scratch.launch, ...args],
      { encoding: "utf8", env: { ...process.env, HERDR_SESSION: lab.name, ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? null), stdout, stderr });
      },
    );
  });

async function workspaceLabels(): Promise<string[]> {
  const listed = records((await lab.run(["workspace", "list"]))["workspaces"]);
  return listed.map((each) => String(each["label"]));
}

test("four fleet up processes at once start the mate once and find it running three times", async () => {
  const finished = await Promise.all(
    Array.from({ length: CONCURRENT_CALLERS }, () => fleet(["up", "ops"])),
  );

  assert.deepEqual(
    finished.map((each) => each.code),
    Array.from({ length: CONCURRENT_CALLERS }, () => 0),
  );
  assert.deepEqual(finished.map((each) => each.stdout).sort(), [
    "ops: already running in 2ndmate-ops\n",
    "ops: already running in 2ndmate-ops\n",
    "ops: already running in 2ndmate-ops\n",
    "ops: started in 2ndmate-ops\n",
  ]);
  assert.deepEqual(await workspaceLabels(), ["2ndmate-ops"]);
  const status = await fleet(["status"]);
  assert.equal(status.stdout, "ops: running\n");
});

test("a lifecycle command that cannot get the lane in time fails and changes nothing, and works once the owner is gone", async () => {
  owner = await LifecycleHolder.hold(home);
  const env = { FLEET_LIFECYCLE_WAIT_MS: CONTENDED_WAIT_MS };

  for (const args of [
    ["up", "ops"],
    ["restart", "ops"],
    ["stop", "ops"],
  ]) {
    const refused = await fleet(args, env);
    assert.notEqual(refused.code, 0, `${args.join(" ")} ran while another process owned the lane`);
    assert.match(refused.stderr, /another fleet command is starting or stopping lane ops/);
  }
  assert.deepEqual(await workspaceLabels(), []);
  assert.equal(existsSync(join(home, "state", "stopped")), false);

  await owner.release();
  assert.equal((await fleet(["up", "ops"], env)).stdout, "ops: started in 2ndmate-ops\n");
});

test("a lane whose owner crashed is not left locked", async () => {
  owner = await LifecycleHolder.hold(home);
  await owner.crash();

  const started = await fleet(["up", "ops"], { FLEET_LIFECYCLE_WAIT_MS: CONTENDED_WAIT_MS });
  assert.equal(started.stdout, "ops: started in 2ndmate-ops\n");
  assert.deepEqual(await workspaceLabels(), ["2ndmate-ops"]);
});
