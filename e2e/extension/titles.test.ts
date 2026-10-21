import assert from "node:assert/strict";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleoHome: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
  const token = cardd.addLane("cleo", "main");
  cleoHome = scratch.addLane("cleo", { url: cardd.url, token, args: mateArgs(h) });
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const fleet = (args: readonly string[]): string => scratch.fleet(args, { HERDR_SESSION: lab.name });

async function titles(): Promise<{ label: string; title: string }[]> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const out: { label: string; title: string }[] = [];
  for (const workspace of workspaces) {
    const listed = await lab.run([
      "pane",
      "list",
      "--workspace",
      String(workspace["workspace_id"]),
    ]);
    const pane = records(listed["panes"])[0];
    out.push({
      label: String(workspace["label"]),
      title: String(pane?.["terminal_title_stripped"]),
    });
  }
  return out;
}

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("main reads 1stmate and a second mate reads 2ndmate-<lane>, in herdr and in Pi", async () => {
  await startMain(lab, scratch, h);
  assert.equal(fleet(["up"]), "cleo: started in 2ndmate-cleo\n");

  const expected = [
    { label: "1stmate", title: `π - 1stmate - ${basename(scratch.root)}` },
    { label: "2ndmate-cleo", title: `π - 2ndmate-cleo - ${basename(cleoHome)}` },
  ];
  const seen = await until("the mates' titles", titles, (now) => {
    return JSON.stringify(now) === JSON.stringify(expected);
  });
  assert.deepEqual(seen, expected);
  assert.equal(fleet(["status"]), "cleo: running\n");
  assert.equal(fleet(["up"]), "cleo: already running in 2ndmate-cleo\n");
});

test("lane tooling still finds a second mate that runs in its old fleet-<lane> workspace", async () => {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    cleoHome,
    "--label",
    "fleet-cleo",
    "--no-focus",
  ]);
  const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  const pi = ["pi", "--continue", ...mateArgs(h)].map((arg) => `'${arg}'`).join(" ");
  await lab.submit(pane, `cd '${cleoHome}' && env -u HERDR_WORKSPACE_ID ${pi}`);

  await until(
    "cleo to run",
    () => Promise.resolve(fleet(["status"])),
    (out) => out === "cleo: running\n",
  );
  assert.equal(fleet(["up"]), "cleo: already running in 2ndmate-cleo\n");
  assert.deepEqual(
    (await titles()).map(({ label }) => label),
    ["fleet-cleo"],
  );
});
