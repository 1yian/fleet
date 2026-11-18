import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleoHome: string;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, mainToken);
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

const labels = async (): Promise<Map<string, string>> =>
  new Map(
    records((await lab.run(["workspace", "list"]))["workspaces"]).map((each) => [
      String(each["workspace_id"]),
      String(each["label"]),
    ]),
  );

const commonDir = (dir: string): string =>
  realpathSync(
    execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim(),
  );

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
  assert.equal(commonDir(cleoHome), commonDir(scratch.root));
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
  const workspace = [...(await labels())].find(([, label]) => label === "2ndmate-cleo")?.[0];
  assert.ok(workspace);
  await lab.run(["tab", "create", "--workspace", workspace, "--cwd", scratch.root, "--no-focus"]);
  await lab.run([
    "workspace",
    "report-metadata",
    workspace,
    "--source",
    "fleet",
    "--token",
    "lane=cleo",
    "--token",
    "card=913",
  ]);
  fleet(["arrange"]);
  assert.equal((await labels()).get(workspace), "2ndmate-cleo");
  assert.equal(fleet(["status"]), "cleo: running\n");
  assert.equal(fleet(["up"]), "cleo: already running in 2ndmate-cleo\n");
  assert.equal(fleet(["stop", "cleo"]), "cleo: stopped\n");
  assert.deepEqual([...(await labels()).values()], ["1stmate"]);
});

async function startWithoutRenaming(pane: string): Promise<void> {
  const pi = ["pi", "--continue", ...mateArgs(h), "-e", PROBE].map((arg) => `'${arg}'`).join(" ");
  await lab.submit(pane, `cd '${cleoHome}' && env -u HERDR_WORKSPACE_ID ${pi}`);
  await h.waitFor((event) => event["type"] === "fleet_connected", "Pi to connect without renaming");
}

test("lane lifecycle still finds a live legacy mate without renaming it", async () => {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    cleoHome,
    "--label",
    "fleet-cleo",
    "--no-focus",
  ]);
  const legacy = String(records([created["workspace"]])[0]?.["workspace_id"]);
  const follower = await lab.run([
    "workspace",
    "create",
    "--cwd",
    scratch.root,
    "--label",
    "old-follower",
    "--no-focus",
  ]);
  const worker = String(records([follower["workspace"]])[0]?.["workspace_id"]);
  await lab.run([
    "workspace",
    "report-metadata",
    worker,
    "--source",
    "fleet",
    "--token",
    "lane=cleo",
  ]);
  fleet(["arrange"]);
  assert.deepEqual([...(await labels()).values()], ["fleet-cleo", "[cleo] old-follower"]);

  const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  await startWithoutRenaming(pane);
  assert.equal(fleet(["status"]), "cleo: running\n");
  assert.equal(fleet(["up"]), "cleo: already running in 2ndmate-cleo\n");
  fleet(["arrange"]);
  assert.deepEqual(
    [...(await labels())],
    [
      [legacy, "fleet-cleo"],
      [worker, "└ old-follower"],
    ],
  );
  assert.equal(fleet(["stop", "cleo"]), "cleo: stopped\n");
  assert.deepEqual(await labels(), new Map([[worker, "└ old-follower"]]));
});

test("up reuses an idle legacy workspace in the lane home", async () => {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    cleoHome,
    "--label",
    "fleet-cleo",
    "--no-focus",
  ]);
  const legacy = String(records([created["workspace"]])[0]?.["workspace_id"]);
  assert.equal(fleet(["status"]), "cleo: down\n");
  assert.equal(fleet(["up"]), "cleo: started in 2ndmate-cleo\n");
  const started = await until("the reused workspace to get its canonical title", labels, (now) =>
    [...now.values()].includes("2ndmate-cleo"),
  );
  assert.deepEqual(started, new Map([[legacy, "2ndmate-cleo"]]));
  assert.equal(fleet(["status"]), "cleo: running\n");
});

test("a worker named fleet-<lane> is never taken for that lane's mate", async () => {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    cleoHome,
    "--label",
    "fleet-cleo",
    "--no-focus",
  ]);
  const worker = String(records([created["workspace"]])[0]?.["workspace_id"]);
  await lab.run([
    "workspace",
    "report-metadata",
    worker,
    "--source",
    "fleet",
    "--token",
    "lane=cleo",
    "--token",
    "card=913",
  ]);
  const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  await startWithoutRenaming(pane);

  assert.equal(fleet(["status"]), "cleo: down\n");
  fleet(["arrange"]);
  assert.equal((await labels()).get(worker), "[cleo] fleet-cleo");
  await lab.run(["workspace", "rename", worker, "fleet-cleo"]);
  assert.equal(fleet(["up"]), "cleo: started in 2ndmate-cleo\n");
  const started = await until("cleo's workspace", labels, (now) =>
    [...now.values()].includes("2ndmate-cleo"),
  );
  assert.equal(started.get(worker), "\u2514 fleet-cleo");
  fleet(["arrange"]);
  assert.deepEqual([...(await labels()).values()], ["2ndmate-cleo", "\u2514 fleet-cleo"]);

  fleet(["stop", "cleo"]);
  const stopped = await until("cleo's workspace to close", labels, (now) => now.size === 1);
  assert.deepEqual([...stopped.values()], ["\u2514 fleet-cleo"]);
});

test("a mate Pi that only inherited a worker pane's herdr environment leaves that worker's workspace alone", async () => {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    scratch.root,
    "--label",
    "└ fleet-shared-browser",
    "--no-focus",
  ]);
  const worker = String(records([created["workspace"]])[0]?.["workspace_id"]);
  await lab.run([
    "workspace",
    "report-metadata",
    worker,
    "--source",
    "fleet",
    "--token",
    "lane=cleo",
    "--token",
    "card=912",
  ]);
  h.startPi(
    "main",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: mainToken,
      FLEET_ROLE: "mate",
      FLEET_LANE: "main",
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      HERDR_WORKSPACE_ID: worker,
    },
    [EXTENSION],
  );
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate Pi to join the fleet");

  assert.equal(fleet(["up"]), "cleo: started in 2ndmate-cleo\n");
  const seen = await until("cleo's workspace to be named", labels, (now) =>
    [...now.values()].includes("2ndmate-cleo"),
  );
  assert.equal(seen.get(worker), "└ fleet-shared-browser");
  assert.ok(![...seen.values()].includes("1stmate"), JSON.stringify([...seen.values()]));
});

test("a second mate that starts in a workspace with the wrong label corrects it and keeps its panes", async () => {
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    cleoHome,
    "--label",
    "1stmate",
    "--no-focus",
  ]);
  const workspace = String(records([created["workspace"]])[0]?.["workspace_id"]);
  const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  const pi = ["pi", "--continue", ...mateArgs(h)].map((arg) => `'${arg}'`).join(" ");
  await lab.submit(pane, `cd '${cleoHome}' && ${pi}`);

  await until("the workspace to read 2ndmate-cleo", labels, (now) => {
    return now.get(workspace) === "2ndmate-cleo";
  });
  const filesTab = await until(
    "the Files tab",
    async () =>
      records((await lab.run(["tab", "list", "--workspace", workspace]))["tabs"]).find(
        (each) => each["label"] === "Files",
      ),
    (found) => found !== undefined,
  );
  const panes = await lab.run(["pane", "list", "--workspace", workspace]);
  assert.deepEqual(
    records(panes["panes"])
      .filter((each) => each["tab_id"] !== filesTab?.["tab_id"])
      .map((each) => each["pane_id"]),
    [pane],
  );
  await until(
    "cleo to run",
    () => Promise.resolve(fleet(["status"])),
    (out) => out === "cleo: running\n",
  );
  assert.equal(fleet(["up"]), "cleo: already running in 2ndmate-cleo\n");
  assert.deepEqual([...(await labels()).values()], ["2ndmate-cleo"]);
});
