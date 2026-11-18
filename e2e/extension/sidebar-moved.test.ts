import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { addRemote, git, landOnRemote } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const SESSION_TRANSPORT = fileURLToPath(
  new URL("../support/session-transport.ts", import.meta.url),
);
const REMOTE = "annex.eu.example";
const OWN_LABEL = hostname().toLowerCase().split(".")[0] ?? "";
const AWAY_RECIPE = `onboarding = false

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$away", dim = true }],
]
`;

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let far: HerdrLab;
let here: Scratch;
let p620: Scratch;
let tokens: Record<string, string>;
beforeEach(async () => {
  h = await Harness.start();
  here = new Scratch();
  const remote = addRemote(here.root);
  p620 = new Scratch("fleet");
  git(p620.root, "remote", "add", "origin", remote);
  git(p620.root, "fetch", "-q", "origin");
  git(p620.root, "reset", "-q", "--hard", "origin/main");
  cardd = await Cardd.start();
  tokens = { main: cardd.addLane("main", undefined, here.root) };
  const env = { ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` };
  lab = await HerdrLab.start({ ...env, FLEET_SUPERVISE_MS: "1000" });
  far = await HerdrLab.start(env);
  configureMain(here, cardd.url, tokens["main"], {
    host: "local",
    hosts: { [REMOTE]: ["node", SESSION_TRANSPORT, far.name, lab.name] },
    roots: { [REMOTE]: p620.root },
  });
  tokens["ops"] = cardd.addLane("ops", "main");
  const ops = { url: cardd.url, token: tokens["ops"], args: mateArgs(h), hold: true };
  here.addLane("ops", ops);
  p620.addLane("ops", { ...ops, host: REMOTE });
  landOnRemote(remote, "fleet-fix");
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  await far.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), far.stop(), h.stop(), cardd.stop()]);
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

function statusOf(scratch: Scratch, session: string): Record<string, string> {
  const out = scratch.fleet(["status", "--json"], { HERDR_SESSION: session });
  const parsed = records(JSON.parse(out.trim().split("\n").at(-1) ?? "[]"));
  return Object.fromEntries(parsed.map((row) => [String(row["lane"]), String(row["state"])]));
}

async function open(
  on: HerdrLab,
  label: string,
  cwd: string,
): Promise<{ pane: string; id: string }> {
  const made = await on.run(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  return {
    pane: String(records([made["root_pane"]])[0]?.["pane_id"]),
    id: String(records([made["workspace"]])[0]?.["workspace_id"]),
  };
}

async function mark(on: HerdrLab, workspace: string, ...marks: string[]): Promise<void> {
  const tokensArgs = marks.flatMap((each) => ["--token", each]);
  await on.run(["workspace", "report-metadata", workspace, "--source", "fleet", ...tokensArgs]);
}

async function tokensOf(on: HerdrLab, label: string): Promise<Record<string, unknown>> {
  const row = records((await on.run(["workspace", "list"]))["workspaces"]).find(
    (each) => each["label"] === label,
  );
  const found = row?.["tokens"];
  assert.ok(typeof found === "object" && found !== null, `no tokens on ${label}`);
  return { ...found };
}

async function renderClient(): Promise<string> {
  const config = join(tempDir("herdr-client-"), "config.toml");
  writeFileSync(config, AWAY_RECIPE);
  const { pane } = await open(lab, "client", here.root);
  const unset = "-u HERDR_SESSION -u HERDR_SOCKET_PATH -u HERDR_ENV";
  await lab.submit(pane, `env ${unset} HERDR_CONFIG_PATH='${config}' herdr --session ${far.name}`);
  return pane;
}

async function untilScreen(what: string, pane: string, holds: (lines: string[]) => boolean) {
  const read = async (): Promise<string[]> =>
    (await lab.screen(pane)).split("\n").map((line) => line.split("\u2502")[0] ?? "");
  return until(
    async () => {
      const lines = await read();
      return holds(lines) ? lines : undefined;
    },
    what,
    async () => (await read()).join("\n"),
  );
}

const rowAfter = (lines: readonly string[], text: string, offset: number): string =>
  lines[lines.findIndex((line) => line.includes(text)) + offset] ?? "";

async function moveOpsToP620(): Promise<void> {
  p620.fleet(["up", "ops"], {
    HERDR_SESSION: far.name,
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  await until(
    () => (statusOf(p620, far.name)["ops"] === "running" ? true : undefined),
    "ops to run on p620",
    () => Promise.resolve(JSON.stringify(statusOf(p620, far.name))),
  );
}

async function busyOldHome(): Promise<void> {
  const old = await open(lab, "2ndmate-ops", `${here.root}.worktrees/lane-ops`);
  await lab.submit(old.pane, "sleep 600");
  await until(
    () => (statusOf(here, lab.name)["ops"] === "running" ? true : undefined),
    "lifecycle status to see the busy old home",
    () => Promise.resolve(JSON.stringify(statusOf(here, lab.name))),
  );
}

async function updateFleet(pane: string): Promise<void> {
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, "the mate's connection");
  await lab.submit(pane, "/updatefleet");
  await until(
    () => {
      const sessions = join(h.dir, "sessions");
      if (!existsSync(sessions)) return undefined;
      const text = readdirSync(sessions).map((file) => readFileSync(join(sessions, file), "utf8"));
      return text.join("\n").includes("[fleet] update: Fleet updated.") ? true : undefined;
    },
    "main to record the update's report",
    () => Promise.resolve(""),
  );
}

test("a main whose host is local, and a lane that moved hosts, tell each worker where its mate runs, and herdr shows it beside the Git row", async () => {
  await busyOldHome();
  await moveOpsToP620();
  const pane = await startMain(lab, here, h);
  const alpha = await open(lab, "ops-alpha", here.root);
  await mark(lab, alpha.id, "lane=ops", "mate=gone-host");
  const worker = await open(far, "main-far", here.root);
  await mark(far, worker.id, "lane=main", "mate=stale-host");
  const client = await renderClient();

  await updateFleet(pane);

  const moved = await tokensOf(lab, "└ ops-alpha");
  assert.equal(moved["mate"], REMOTE);
  assert.equal(moved["away"], undefined);
  const remote = await tokensOf(far, "[main] main-far");
  assert.equal(remote["mate"], OWN_LABEL);
  assert.equal(remote["away"], `\u2197 mate on ${OWN_LABEL}`);

  const awayFrame = (lines: string[]): boolean =>
    lines.some((line) => line.includes("[main] main-far")) &&
    rowAfter(lines, "[main] main-far", 1).includes("main") &&
    rowAfter(lines, "[main] main-far", 2).includes(`mate on ${OWN_LABEL}`);
  await untilScreen("the hint under the Git row", client, awayFrame);

  const localMate = await open(far, "1stmate", here.root);
  p620.fleet(["arrange", "--host", REMOTE], { HERDR_SESSION: far.name });
  await untilScreen(
    "the grouped worker with Git and no hint",
    client,
    (lines) =>
      lines.some((line) => line.includes("└ main-far")) &&
      rowAfter(lines, "└ main-far", 1).includes("main") &&
      !lines.some((line) => line.includes("mate on")),
  );
  assert.equal((await tokensOf(far, "└ main-far"))["mate"], OWN_LABEL);

  await far.run(["workspace", "close", localMate.id]);
  p620.fleet(["arrange", "--host", REMOTE], { HERDR_SESSION: far.name });
  await untilScreen("the lane prefix, Git row and restored hint", client, awayFrame);
});

test("a busy non-mate shell cannot replace stored placement when neither home has a mate", async () => {
  const pane = await startMain(lab, here, h);
  await busyOldHome();
  const worker = await open(far, "ops-alpha", p620.root);
  await mark(far, worker.id, "lane=ops", "mate=gone-host");
  assert.equal(statusOf(p620, far.name)["ops"], "stopped");

  await updateFleet(pane);

  const kept = await tokensOf(far, "[ops] ops-alpha");
  assert.equal(kept["mate"], "gone-host");
  assert.equal(kept["away"], "\u2197 mate on gone-host");
});

test("arrange preserves hints without an identity and refreshes them with the lane home's name", async () => {
  const inside = await open(lab, "inside", here.root);
  await mark(lab, inside.id, "lane=aa", `mate=${REMOTE}`);
  const outside = await open(lab, "outside", here.root);
  const otherHost = "annex.us.example";
  await mark(lab, outside.id, "lane=bb", `mate=${otherHost}`, "away=↗ mate on saved-host");
  const env = { ...process.env };
  delete env["FLEET_HOST"];
  const launch = join(
    `${p620.root}.worktrees`,
    "lane-ops",
    "packages",
    "extension",
    "src",
    "launch.ts",
  );
  const session = { ...env, HERDR_SESSION: lab.name, PATH: `${BIN}:${process.env["PATH"] ?? ""}` };
  execFileSync("node", [p620.launch, "arrange"], { env: session });
  assert.equal((await tokensOf(lab, "[aa] inside"))["away"], undefined);
  assert.equal((await tokensOf(lab, "[bb] outside"))["away"], "↗ mate on saved-host");

  execFileSync("node", [launch, "arrange"], { env: session });

  assert.equal((await tokensOf(lab, "[aa] inside"))["away"], undefined);
  assert.equal((await tokensOf(lab, "[bb] outside"))["away"], `↗ mate on ${otherHost}`);

  await mark(lab, inside.id, "away=↗ mate on stale-host");
  assert.throws(
    () => execFileSync("node", [p620.launch, "up", "ops", "--host", otherHost], { env: session }),
    { status: 2 },
  );
  execFileSync("node", [p620.launch, "up", "ops"], { env: session });
  assert.equal(statusOf(p620, lab.name)["ops"], "running");
  assert.equal((await tokensOf(lab, "[aa] inside"))["away"], undefined);
  assert.equal((await tokensOf(lab, "[bb] outside"))["away"], `↗ mate on ${otherHost}`);
});

test("an authoritative host too long for Herdr clears the superseded placement and hint", async () => {
  const long = `${"annex".repeat(16)}.example`;
  configureMain(here, cardd.url, tokens["main"], {
    host: "local",
    hosts: { [long]: ["node", SESSION_TRANSPORT, far.name, lab.name] },
    roots: { [long]: p620.root },
  });
  await moveOpsToP620();
  const pane = await startMain(lab, here, h);
  const worker = await open(lab, "ops-alpha", here.root);
  await mark(lab, worker.id, "lane=ops", "card=19", "mate=old-host", "away=↗ mate on old-host");

  await updateFleet(pane);

  const updated = await tokensOf(lab, "[ops] ops-alpha");
  assert.equal(updated["lane"], "ops");
  assert.equal(updated["card"], "19");
  assert.equal(updated["mate"], undefined);
  assert.equal(updated["away"], undefined);
});
