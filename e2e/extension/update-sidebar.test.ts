import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { addRemote, git, landOnRemote } from "../support/remote.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/fault-transport.ts", import.meta.url));
const ORDERED = ["~", "1stmate", "2ndmate-far", "└ far-one", "2ndmate-ops", "└ ops-alpha"];

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let faults: string;
let tokens: Record<string, string>;
let pane: string;
beforeEach(async () => {
  h = await Harness.start();
  here = new Scratch();
  const remote = addRemote(here.root);
  p620 = new Scratch("fleet");
  git(p620.root, "remote", "add", "origin", remote);
  git(p620.root, "fetch", "-q", "origin");
  git(p620.root, "reset", "-q", "--hard", "origin/main");
  cardd = await Cardd.start();
  faults = join(here.parent, "p620-faults");
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TRANSPORT, faults] },
    roots: { p620: p620.root },
  });
  tokens = { main: mainToken };
  for (const lane of ["ops", "far"]) {
    tokens[lane] = cardd.addLane(lane, "main");
    const settings = { url: cardd.url, token: tokens[lane] ?? "", args: mateArgs(h) };
    (lane === "ops" ? here : p620).addLane(lane, settings);
  }
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
  landOnRemote(remote, "fleet-fix");
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  p620.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  detail: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}\n${await detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const sidebar = async (): Promise<string[]> =>
  records((await lab.run(["workspace", "list"]))["workspaces"]).map((each) =>
    String(each["label"]),
  );

async function untilSidebar(expected: readonly string[]): Promise<void> {
  await until(
    async () => ((await sidebar()).join("\n") === expected.join("\n") ? true : undefined),
    `the sidebar to read ${JSON.stringify(expected)}`,
    async () => `the sidebar reads ${JSON.stringify(await sidebar())}`,
  );
}

async function openWorker(lane: string, name: string): Promise<void> {
  const made = await cardd.post(tokens[lane] ?? "", "card.new", {
    title: name,
    name,
    kind: "scout",
  });
  assert.equal(made.status, 200);
  const card = (await cardd.board()).cards.find((each) => each.name === name);
  assert.ok(card !== undefined);
  const cwd = join(here.parent, "site.worktrees", `c-${String(card.id)}-a1`);
  mkdirSync(cwd, { recursive: true });
  await lab.run(["workspace", "create", "--cwd", cwd, "--label", name, "--no-focus"]);
}

async function standIn(label: string): Promise<void> {
  await lab.run(["workspace", "create", "--cwd", here.root, "--label", label, "--no-focus"]);
}

async function scrambledSidebarWithNoMateRunning(): Promise<void> {
  await standIn("~");
  here.fleet(["stop", "ops"], { HERDR_SESSION: lab.name });
  p620.fleet(["stop", "far"], { HERDR_SESSION: lab.name });
  pane = await startMain(lab, here, h);
  await untilSidebar(["~", "1stmate"]);
  await openWorker("ops", "ops-alpha");
  await openWorker("far", "far-one");
  await standIn("2ndmate-ops");
  await standIn("2ndmate-far");
  assert.notDeepEqual(await sidebar(), ORDERED);
}

function lanesOn(scratch: Scratch): { lane: string; state: string; reason?: string }[] {
  const out = scratch.fleet(["status", "--json"], { HERDR_SESSION: lab.name });
  return records(JSON.parse(out.trim().split("\n").at(-1) ?? "[]")).map((row) => ({
    lane: String(row["lane"]),
    state: String(row["state"]),
    ...(typeof row["reason"] === "string" ? { reason: row["reason"] } : {}),
  }));
}

function assertNoMateStarted(): void {
  const stopped = (lane: string) => [{ lane, state: "stopped", reason: "stopped by hand" }];
  assert.deepEqual(lanesOn(here), stopped("ops"));
  assert.deepEqual(lanesOn(p620), stopped("far"));
}

async function updateReport(): Promise<string> {
  await lab.submit(pane, "/updatefleet");
  const sessions = join(h.dir, "sessions");
  const report = await until(
    () => {
      const text = readdirSync(sessions)
        .map((file) => readFileSync(join(sessions, file), "utf8"))
        .join("\n")
        .replaceAll("\\n", "\n");
      return /\[fleet\] update: Fleet updated\.[\s\S]*?\nMain:/.exec(text)?.[0];
    },
    "main to record the update's report",
    async () => `the sidebar reads ${JSON.stringify(await sidebar())}`,
  );
  return report;
}

test("/updatefleet orders every host's sidebar when no mate starts anywhere, and leaves stopped lanes stopped", async () => {
  writeFileSync(faults, "restart-lacks-direnv\n");
  await scrambledSidebarWithNoMateRunning();
  const report = await updateReport();
  await untilSidebar(ORDERED);
  assertNoMateStarted();
  assert.match(report, /Sidebars:\n- local: ordered\n- p620: ordered/);
});

test("/updatefleet names each host whose sidebar it could not order, and still orders the others", async () => {
  writeFileSync(faults, "restart-lacks-direnv\narrange-lacks-session\n");
  await scrambledSidebarWithNoMateRunning();
  const report = await updateReport();
  await untilSidebar(ORDERED);
  assertNoMateStarted();
  assert.match(
    report,
    /Sidebars:\n- local: ordered\n- p620: not ordered - sh on p620 failed: herdr workspace on local failed: .*server_not_running/,
  );
});
