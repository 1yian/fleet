import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const REMOTE = "annex";
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
  for (const lane of ["ops", "far"]) {
    tokens[lane] = cardd.addLane(lane, "main");
    const settings = { url: cardd.url, token: tokens[lane] ?? "", args: mateArgs(h), hold: true };
    (lane === "ops" ? here : p620).addLane(lane, settings);
  }
  p620.addLane("ops", {
    url: cardd.url,
    token: tokens["ops"] ?? "",
    args: mateArgs(h),
    hold: true,
  });
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
  const running = await open(far, "2ndmate-ops", p620.root);
  await far.submit(running.pane, "sleep 600");
  await until(
    () => (statusOf(p620, far.name)["ops"] === "running" ? true : undefined),
    "ops to run on p620",
    () => Promise.resolve(JSON.stringify(statusOf(p620, far.name))),
  );
  assert.equal(statusOf(here, lab.name)["ops"], "stopped");
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
  for (const [scratch, lane] of [
    [here, "ops"],
    [p620, "ops"],
    [p620, "far"],
  ] as const) {
    const state = join(`${scratch.root}.worktrees`, `lane-${lane}`, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "stopped"), "held for the test\n");
  }
  await moveOpsToP620();
  const pane = await startMain(lab, here, h);
  const made = await cardd.post(tokens["ops"] ?? "", "card.new", {
    title: "ops-alpha",
    name: "ops-alpha",
    kind: "scout",
  });
  assert.equal(made.status, 200);
  const cwd = join(here.parent, "site.worktrees", "c-1-a1");
  mkdirSync(cwd, { recursive: true });
  const alpha = await open(lab, "ops-alpha", cwd);
  await mark(lab, alpha.id, "lane=ops", "mate=gone-host");
  const worker = await open(far, "main-far", here.root);
  await mark(far, worker.id, "lane=main", "mate=stale-host");
  const client = await renderClient();

  await updateFleet(pane);

  const moved = await tokensOf(lab, "[ops] ops-alpha");
  assert.equal(moved["mate"], REMOTE);
  assert.equal(moved["away"], `\u2197 mate on ${REMOTE}`);
  const remote = await tokensOf(far, "[main] main-far");
  assert.equal(remote["mate"], OWN_LABEL);
  assert.equal(remote["away"], `\u2197 mate on ${OWN_LABEL}`);

  const shown = await untilScreen("the hint under the Git row", client, (lines) =>
    lines.some((line) => line.includes(`mate on ${OWN_LABEL}`)),
  );
  assert.ok(rowAfter(shown, "[main] main-far", 1).includes("main"), shown.join("\n"));
  assert.ok(rowAfter(shown, "[main] main-far", 2).includes(`mate on ${OWN_LABEL}`));

  await open(far, "1stmate", here.root);
  p620.fleet(["arrange"], { HERDR_SESSION: far.name, FLEET_HOST: REMOTE });
  const home = await untilScreen("the worker to move under its mate", client, (lines) =>
    lines.some((line) => line.includes("\u2514 main-far")),
  );
  assert.ok(!home.join("\n").includes("mate on"), home.join("\n"));
  assert.ok(rowAfter(home, "\u2514 main-far", 1).includes("main"), home.join("\n"));
});
